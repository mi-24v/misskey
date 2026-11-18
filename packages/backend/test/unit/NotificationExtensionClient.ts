/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import { createHmac } from 'node:crypto';
import * as dns from 'node:dns';
import { readFileSync } from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { HttpsProxyAgent } from 'hpagent';
import type * as Redis from 'ioredis';
import type { Config } from '@/config.js';
import {
	createNotificationExtensionAgent,
	NotificationExtensionClient,
} from '@/core/NotificationExtensionClient.js';
import type { NotificationExtensionAgentOptions } from '@/core/NotificationExtensionClient.js';
import { HttpRequestService } from '@/core/HttpRequestService.js';
import { NotificationService } from '@/core/NotificationService.js';
import { allSettled } from '@/misc/promise-tracker.js';
import type { MiNotification } from '@/models/Notification.js';

const _filename = fileURLToPath(import.meta.url);
const _dirname = dirname(_filename);
const fixtures = `${_dirname}/../resources/notification-extension-tls`;

function fixture(name: string): Buffer {
	return readFileSync(`${fixtures}/${name}`);
}

const extensionHost = 'notification-extension.test';
const secret = 'test-only-shared-secret';
const userAgent = 'Misskey/test (https://misskey.test)';
const notificationsPath = '/api/v1/notifications';

type ReceivedRequest = {
	method: string;
	url: string;
	headers: http.IncomingHttpHeaders;
	body: string;
};

type TestServer = {
	port: number;
	received: ReceivedRequest[];
	sockets: Set<net.Socket>;
	server: http.Server | https.Server;
	handle: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;
};

const openServers = new Set<net.Server>();

async function listen(server: net.Server): Promise<number> {
	openServers.add(server);
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	return (server.address() as net.AddressInfo).port;
}

async function startServer(kind: 'https' | 'http', certName = 'server'): Promise<TestServer> {
	const received: ReceivedRequest[] = [];
	const sockets = new Set<net.Socket>();
	let handle: TestServer['handle'] = (_req, res) => {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end('[]');
	};

	const listener: http.RequestListener = (req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (chunk: Buffer) => chunks.push(chunk));
		req.on('end', () => {
			const body = Buffer.concat(chunks).toString('utf8');
			received.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
			handle(req, res, body);
		});
	};

	const server = kind === 'https'
		? https.createServer({ key: fixture(`${certName}.key`), cert: fixture(`${certName}.crt`) }, listener)
		: http.createServer(listener);
	// keep-alive のソケットがサーバー側の都合で閉じないようにする
	server.keepAliveTimeout = 60_000;
	server.on(kind === 'https' ? 'secureConnection' : 'connection', (socket: net.Socket) => {
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
	});

	const port = await listen(server);
	return {
		port,
		received,
		sockets,
		server,
		get handle() {
			return handle;
		},
		set handle(value) {
			handle = value;
		},
	};
}

// TCP 接続を数えるだけの敵対的な proxy。受け付けた接続はすぐ閉じる
async function startHostileProxy(): Promise<{ url: string; connections: () => number }> {
	let connections = 0;
	const server = net.createServer(socket => {
		connections++;
		socket.destroy();
	});
	const port = await listen(server);
	return { url: `http://127.0.0.1:${port}`, connections: () => connections };
}

function createLookup(): { lookup: net.LookupFunction; hostnames: string[] } {
	const hostnames: string[] = [];
	const lookup = ((hostname: string, options: dns.LookupOptions, callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void) => {
		hostnames.push(hostname);
		if (hostname !== extensionHost) {
			callback(Object.assign(new Error(`unexpected lookup: ${hostname}`), { code: 'ENOTFOUND' }), '', 4);
			return;
		}
		if (options.all) {
			callback(null, [{ address: '127.0.0.1', family: 4 }]);
		} else {
			callback(null, '127.0.0.1', 4);
		}
	}) as net.LookupFunction;
	return { lookup, hostnames };
}

function createConfig(baseUrl: string, override: Partial<Config> = {}, timeoutMs?: number): Config {
	return {
		perUserNotificationsMaxCount: 500,
		userAgent,
		notificationExtension: {
			baseUrl,
			secret,
			timeoutMs,
		},
		...override,
	} as Config;
}

const clients: NotificationExtensionClient[] = [];
const services: NotificationService[] = [];

function createClient(config: Config, agentOptions?: NotificationExtensionAgentOptions): NotificationExtensionClient {
	const client = new NotificationExtensionClient(config, agentOptions);
	clients.push(client);
	return client;
}

type AsyncMock = jest.Mock<(...args: unknown[]) => Promise<unknown>>;

function createNotificationService(config: Config, client: NotificationExtensionClient) {
	const redisClient = {
		xrange: jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue([]),
		xrevrange: jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue([]),
		xadd: jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue('2000-2'),
		get: jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(null),
		set: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
		del: jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(1),
	} as unknown as Redis.Redis;
	const cacheService = {
		userProfileCache: { fetch: jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ notificationRecieveConfig: {} }) as AsyncMock },
		userMutingsCache: { fetch: jest.fn<(...args: unknown[]) => Promise<unknown>>() },
		userFollowingsCache: { fetch: jest.fn<(...args: unknown[]) => Promise<unknown>>() },
	};
	const service = new NotificationService(
		config,
		redisClient,
		{} as any,
		{ pack: jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ id: 'notification-id' }) } as any,
		{
			gen: jest.fn<(...args: unknown[]) => unknown>().mockReturnValue('notification-id'),
			parseFull: jest.fn<(...args: unknown[]) => unknown>().mockReturnValue({ date: 2000, additional: 2n }),
		} as any,
		{ publishMainStream: jest.fn() } as any,
		{ pushNotification: jest.fn() } as any,
		cacheService as any,
		{ membersCache: { fetch: jest.fn() } } as any,
		client,
	);
	services.push(service);
	return service;
}

const sampleNotification = {
	id: 'notification-id',
	type: 'reaction',
	createdAt: '2026-07-01T00:00:00.000Z',
	notifierId: 'actor-id',
	noteId: 'note-id',
	reaction: ':test:',
} satisfies MiNotification;

function expectValidJwt(authorization: string | undefined) {
	expect(authorization).toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/);
	const [header, payload, signature] = authorization!.slice('Bearer '.length).split('.');
	expect(createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')).toBe(signature);
	expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'HS256', typ: 'JWT' });
	const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
	expect(claims).toMatchObject({ iss: 'misskey', sub: 'notification-extension' });
	expect(claims.exp - claims.iat).toBe(60);
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) return false;
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	return true;
}

describe('NotificationExtensionClient', () => {
	const ca = fixture('ca.crt');

	beforeEach(() => {
		clients.length = 0;
		services.length = 0;
	});

	afterEach(async () => {
		for (const service of services) service.dispose();
		for (const client of clients) client.onApplicationShutdown();
		for (const server of openServers) {
			if (server instanceof http.Server) server.closeAllConnections();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
		openServers.clear();
	});

	test('NotificationService reads through the dedicated TLS agent', async () => {
		const extension = await startServer('https');
		extension.handle = (_req, res) => {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify([sampleNotification]));
		};
		const { lookup, hostnames } = createLookup();
		const config = createConfig(`https://${extensionHost}:${extension.port}`);
		const service = createNotificationService(config, createClient(config, { lookup, ca }));

		const result = await service.getNotifications('target-user-id', {
			limit: 10,
			includeTypes: ['reaction'],
			excludeTypes: ['follow'],
		});

		expect(result).toEqual([sampleNotification]);
		expect(extension.received).toHaveLength(1);
		const [req] = extension.received;
		expect(req.method).toBe('GET');
		const url = new URL(req.url, 'https://placeholder.invalid');
		expect(url.pathname).toBe(notificationsPath);
		expect(url.searchParams.get('userId')).toBe('target-user-id');
		expect(url.searchParams.get('limit')).toBe('10');
		expect(url.searchParams.getAll('includeTypes')).toEqual(['reaction']);
		expect(url.searchParams.getAll('excludeTypes')).toEqual(['follow']);
		expect(req.headers.host).toBe(`${extensionHost}:${extension.port}`);
		expect(req.headers['user-agent']).toBe(userAgent);
		expect(req.headers.accept).toBe('application/json');
		expectValidJwt(req.headers.authorization);
		expect(hostnames).toContain(extensionHost);
	});

	test('persists and deletes through the same agent', async () => {
		const extension = await startServer('https');
		const { lookup } = createLookup();
		const config = createConfig(`https://${extensionHost}:${extension.port}`);
		const service = createNotificationService(config, createClient(config, { lookup, ca }));

		service.createNotification('target-user-id', 'test', {});
		await allSettled();
		await service.flushAllNotifications('target-user-id');

		expect(extension.received).toHaveLength(2);
		const [post, del] = extension.received;
		expect(post.method).toBe('POST');
		expect(post.url).toBe(notificationsPath);
		expect(post.headers['content-type']).toBe('application/json');
		expectValidJwt(post.headers.authorization);
		expect(JSON.parse(post.body)).toMatchObject({
			id: 'notification-id',
			type: 'test',
			notifieeId: 'target-user-id',
			isRead: false,
		});
		expect(del.method).toBe('DELETE');
		const deleteUrl = new URL(del.url, 'https://placeholder.invalid');
		expect(deleteUrl.pathname).toBe(notificationsPath);
		expect(deleteUrl.searchParams.get('userId')).toBe('target-user-id');
		expectValidJwt(del.headers.authorization);
	});

	test.each(['wrong-san', 'expired'])('rejects %s certificate', async (certName) => {
		const extension = await startServer('https', certName);
		const { lookup } = createLookup();
		const config = createConfig(`https://${extensionHost}:${extension.port}`);
		const service = createNotificationService(config, createClient(config, { lookup, ca }));

		await expect(service.getNotifications('target-user-id', { limit: 10 })).resolves.toEqual([]);
		expect(extension.received).toHaveLength(0);
	});

	test('rejects an untrusted CA when ca is not injected', async () => {
		const extension = await startServer('https');
		const { lookup } = createLookup();
		const config = createConfig(`https://${extensionHost}:${extension.port}`);
		const service = createNotificationService(config, createClient(config, { lookup }));

		await expect(service.getNotifications('target-user-id', { limit: 10 })).resolves.toEqual([]);
		expect(extension.received).toHaveLength(0);
	});

	test('does not follow redirects', async () => {
		const elsewhere = await startServer('https');
		const extension = await startServer('https');
		extension.handle = (_req, res) => {
			res.writeHead(302, { Location: `https://${extensionHost}:${elsewhere.port}/steal` });
			res.end();
		};
		const { lookup } = createLookup();
		const config = createConfig(`https://${extensionHost}:${extension.port}`);
		const client = createClient(config, { lookup, ca });
		const service = createNotificationService(config, client);

		await expect(service.getNotifications('target-user-id', { limit: 10 })).resolves.toEqual([]);
		service.createNotification('target-user-id', 'test', {});
		await allSettled();
		await service.flushAllNotifications('target-user-id');

		expect(extension.received.map(req => req.method)).toEqual(['GET', 'POST', 'DELETE']);
		expect(elsewhere.received).toHaveLength(0);
		expect(elsewhere.sockets.size).toBe(0);
	});

	test('ignores config.proxy and HTTP_PROXY/HTTPS_PROXY for the configured endpoint', async () => {
		const proxy = await startHostileProxy();
		const extension = await startServer('https');
		const { lookup } = createLookup();
		const config = createConfig(`https://${extensionHost}:${extension.port}`, {
			proxy: proxy.url,
			proxyBypassHosts: [],
		});
		const savedEnv = {
			HTTP_PROXY: process.env.HTTP_PROXY,
			HTTPS_PROXY: process.env.HTTPS_PROXY,
			http_proxy: process.env.http_proxy,
			https_proxy: process.env.https_proxy,
			NO_PROXY: process.env.NO_PROXY,
			no_proxy: process.env.no_proxy,
		};
		try {
			process.env.HTTP_PROXY = proxy.url;
			process.env.HTTPS_PROXY = proxy.url;
			process.env.http_proxy = proxy.url;
			process.env.https_proxy = proxy.url;
			delete process.env.NO_PROXY;
			delete process.env.no_proxy;
			const service = createNotificationService(config, createClient(config, { lookup, ca }));

			await expect(service.getNotifications('target-user-id', { limit: 10 })).resolves.toEqual([]);
		} finally {
			for (const [key, value] of Object.entries(savedEnv)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}

		expect(extension.received).toHaveLength(1);
		expect(proxy.connections()).toBe(0);
	});

	test('keeps timeout and size semantics', async () => {
		const { lookup } = createLookup();

		// 応答ヘッダーを返さないサーバー
		const silent = await startServer('https');
		silent.handle = () => { /* never respond */ };
		const silentConfig = createConfig(`https://${extensionHost}:${silent.port}`, {}, 50);
		const silentService = createNotificationService(silentConfig, createClient(silentConfig, { lookup, ca }));
		const startedAt = Date.now();
		await expect(silentService.getNotifications('target-user-id', { limit: 10 })).resolves.toEqual([]);
		expect(Date.now() - startedAt).toBeLessThan(2000);
		expect(silent.received).toHaveLength(1);

		// ヘッダーだけ返して本文を止めるサーバー（timeout は本文の読み取りにも効く）
		const stalled = await startServer('https');
		stalled.handle = (_req, res) => {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.write('[');
		};
		const stalledConfig = createConfig(`https://${extensionHost}:${stalled.port}`, {}, 50);
		const stalledService = createNotificationService(stalledConfig, createClient(stalledConfig, { lookup, ca }));
		const stalledStartedAt = Date.now();
		await expect(stalledService.getNotifications('target-user-id', { limit: 10 })).resolves.toEqual([]);
		expect(Date.now() - stalledStartedAt).toBeLessThan(2000);

		// 256 KiB を超える応答
		const large = await startServer('https');
		const largeBody = JSON.stringify(Array.from({ length: 1024 }, (_, i) => ({ ...sampleNotification, id: `${i}`, reaction: 'x'.repeat(256) })));
		expect(Buffer.byteLength(largeBody)).toBeGreaterThan(1024 * 256);
		large.handle = (_req, res) => {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(largeBody);
		};
		const largeConfig = createConfig(`https://${extensionHost}:${large.port}`);
		const largeClient = createClient(largeConfig, { lookup, ca });
		const largeService = createNotificationService(largeConfig, largeClient);
		await expect(largeService.getNotifications('target-user-id', { limit: 10 })).resolves.toEqual([]);
		const largeRes = await largeClient.request('GET');
		await expect(largeRes!.json()).rejects.toMatchObject({ type: 'max-size' });

		// !ok は [] になり、POST・DELETE の失敗は例外にならない
		const failing = await startServer('https');
		failing.handle = (_req, res) => {
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify([sampleNotification]));
		};
		const failingConfig = createConfig(`https://${extensionHost}:${failing.port}`);
		const failingClient = createClient(failingConfig, { lookup, ca });
		const failingService = createNotificationService(failingConfig, failingClient);
		await expect(failingService.getNotifications('target-user-id', { limit: 10 })).resolves.toEqual([]);
		await expect(failingClient.request('POST', undefined, { id: 'notification-id' })).resolves.toMatchObject({ ok: false, status: 500 });
		await expect(failingService.flushAllNotifications('target-user-id')).resolves.toBeUndefined();

		// 接続できない場合は例外ではなく null
		const closed = await startServer('https');
		const closedPort = closed.port;
		openServers.delete(closed.server);
		await new Promise<void>(resolve => closed.server.close(() => resolve()));
		const closedConfig = createConfig(`https://${extensionHost}:${closedPort}`);
		const closedClient = createClient(closedConfig, { lookup, ca });
		await expect(closedClient.request('POST', undefined, { id: 'notification-id' })).resolves.toBeNull();
	});

	test('uses timeoutMs 5000 by default', async () => {
		const { lookup } = createLookup();
		const config = createConfig(`https://${extensionHost}:1`);
		const client = createClient(config, { lookup, ca });
		const timeoutSpy = jest.spyOn(AbortSignal, 'timeout');

		await client.request('GET');

		expect(timeoutSpy).toHaveBeenCalledWith(5000);
	});

	test('supports http origins for local development without proxy', async () => {
		const proxy = await startHostileProxy();
		const extension = await startServer('http');
		extension.handle = (_req, res) => {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify([sampleNotification]));
		};
		const { lookup, hostnames } = createLookup();
		const config = createConfig(`http://${extensionHost}:${extension.port}`, {
			proxy: proxy.url,
			proxyBypassHosts: [],
		});
		const service = createNotificationService(config, createClient(config, { lookup }));

		await expect(service.getNotifications('target-user-id', { limit: 10 })).resolves.toEqual([sampleNotification]);
		expect(extension.received).toHaveLength(1);
		expectValidJwt(extension.received[0].headers.authorization);
		expect(hostnames).toContain(extensionHost);
		expect(proxy.connections()).toBe(0);
	});

	test('default agent uses dns.lookup, not cacheable-lookup (lookup:false)', () => {
		const httpsAgent = createNotificationExtensionAgent(new URL(`https://${extensionHost}`));
		const httpAgent = createNotificationExtensionAgent(new URL(`http://${extensionHost}:8080`));
		try {
			expect(httpsAgent).toBeInstanceOf(https.Agent);
			expect(httpsAgent).not.toBeInstanceOf(HttpsProxyAgent);
			expect(httpAgent).toBeInstanceOf(http.Agent);
			expect(httpAgent).not.toBeInstanceOf(https.Agent);
			for (const agent of [httpsAgent, httpAgent]) {
				const options = (agent as unknown as { options: https.AgentOptions }).options;
				expect(options.lookup).toBe(dns.lookup);
				expect(options.keepAlive).toBe(true);
				expect(options.ca).toBeUndefined();
				expect(options.localAddress).toBeUndefined();
				// 標準の証明書検証を無効にしない
				expect(options.rejectUnauthorized).not.toBe(false);
			}
		} finally {
			httpsAgent.destroy();
			httpAgent.destroy();
		}
	});

	test('generic HttpRequestService agents are unchanged', async () => {
		const proxy = await startHostileProxy();
		const config = { proxy: proxy.url, proxyBypassHosts: [] } as unknown as Config;
		const httpRequestService = new HttpRequestService(config);

		expect(httpRequestService.getAgentByUrl(new URL(`https://${extensionHost}`), false, true)).toBeInstanceOf(HttpsProxyAgent);
		expect(config.proxyBypassHosts).toEqual([]);
	});

	test('never sends to a URL other than origin + /api/v1/notifications', async () => {
		const extension = await startServer('https');
		const { lookup } = createLookup();
		const config = createConfig(`https://${extensionHost}:${extension.port}`);
		const client = createClient(config, { lookup, ca });
		const service = createNotificationService(config, client);

		await service.getNotifications('../../admin?x=1#frag', { limit: 10, sinceId: '/etc/passwd', includeTypes: ['../x'] });
		service.createNotification('target-user-id', 'test', {});
		await allSettled();
		await service.flushAllNotifications('../../target-user-id');
		await client.request('GET', new URLSearchParams([['path', '/other']]));

		expect(extension.received).toHaveLength(4);
		for (const req of extension.received) {
			expect(new URL(req.url, 'https://placeholder.invalid').pathname).toBe(notificationsPath);
		}
	});

	test('destroys the dedicated agent on application shutdown', async () => {
		const extension = await startServer('https');
		const { lookup } = createLookup();
		const config = createConfig(`https://${extensionHost}:${extension.port}`);
		const client = createClient(config, { lookup, ca });

		const res = await client.request('GET');
		expect(res?.ok).toBe(true);
		await res!.text();
		expect(extension.sockets.size).toBeGreaterThanOrEqual(1);

		client.onApplicationShutdown();

		expect(await waitFor(() => extension.sockets.size === 0, 1000)).toBe(true);
		openServers.delete(extension.server);
		let timer: NodeJS.Timeout | undefined;
		const closed = await Promise.race([
			new Promise<boolean>(resolve => extension.server.close(() => resolve(true))),
			new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 1000); }),
		]);
		clearTimeout(timer);
		expect(closed).toBe(true);
	});
});
