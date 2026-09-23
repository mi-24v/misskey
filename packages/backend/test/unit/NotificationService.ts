/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import type * as Redis from 'ioredis';
import type { Response } from 'node-fetch';
import type { Config } from '@/config.js';
import { NotificationService } from '@/core/NotificationService.js';
import type { HttpRequestService } from '@/core/HttpRequestService.js';
import { allSettled } from '@/misc/promise-tracker.js';
import type { MiNotification } from '@/models/Notification.js';

type AsyncMock = jest.Mock<(...args: unknown[]) => Promise<unknown>>;
type SyncMock = jest.Mock<(...args: unknown[]) => unknown>;
type ExtensionSendCall = [
	url: string,
	args: {
		method?: string;
		body?: string;
		headers?: Record<string, string>;
		timeout?: number;
		size?: number;
		isLocalAddressAllowed?: boolean;
	},
	extra: {
		throwErrorWhenResponseNotOk: boolean;
	},
];

function response(json?: unknown, ok = true): Response {
	return {
		ok,
		status: ok ? 200 : 500,
		statusText: ok ? 'OK' : 'Internal Server Error',
		json: async () => json,
	} as Response;
}

describe('NotificationService notification extension integration', () => {
	let redisClient: jest.Mocked<Redis.Redis>;
	let httpRequestService: jest.Mocked<HttpRequestService>;
	let notificationEntityService: {
		pack: AsyncMock;
	};
	let idService: {
		gen: SyncMock;
		parseFull: SyncMock;
	};
	let globalEventService: {
		publishMainStream: SyncMock;
	};
	let pushNotificationService: {
		pushNotification: SyncMock;
	};
	let cacheService: {
		userProfileCache: { fetch: AsyncMock };
		userMutingsCache: { fetch: AsyncMock };
		userFollowingsCache: { fetch: AsyncMock };
	};
	let userListService: {
		membersCache: { fetch: AsyncMock };
	};

	function firstSendCall(): ExtensionSendCall {
		expect(httpRequestService.send).toHaveBeenCalled();
		return httpRequestService.send.mock.calls[0] as ExtensionSendCall;
	}

	function createService(configOverride: Partial<Config> = {}) {
		const config = {
			perUserNotificationsMaxCount: 500,
			userAgent: 'Misskey/test',
			notificationExtension: {
				baseUrl: 'https://notification-extension.example',
				secret: 'shared-secret',
				timeoutMs: 1234,
			},
			...configOverride,
		} as Config;

		return new NotificationService(
			config,
			redisClient,
			{} as any,
			notificationEntityService as any,
			idService as any,
			globalEventService as any,
			pushNotificationService as any,
			cacheService as any,
			userListService as any,
			httpRequestService,
		);
	}

	beforeEach(() => {
		redisClient = {
			xrange: jest.fn(),
			xrevrange: jest.fn(),
			xadd: jest.fn(),
			get: jest.fn(),
			set: jest.fn(),
			del: jest.fn(),
			} as unknown as jest.Mocked<Redis.Redis>;
			httpRequestService = {
				send: jest.fn(),
			} as unknown as jest.Mocked<HttpRequestService>;
			notificationEntityService = {
				pack: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
			};
			idService = {
				gen: jest.fn<(...args: unknown[]) => unknown>(),
				parseFull: jest.fn<(...args: unknown[]) => unknown>(),
			};
			globalEventService = {
				publishMainStream: jest.fn<(...args: unknown[]) => unknown>(),
			};
			pushNotificationService = {
				pushNotification: jest.fn<(...args: unknown[]) => unknown>(),
			};
			cacheService = {
				userProfileCache: { fetch: jest.fn<(...args: unknown[]) => Promise<unknown>>() },
				userMutingsCache: { fetch: jest.fn<(...args: unknown[]) => Promise<unknown>>() },
				userFollowingsCache: { fetch: jest.fn<(...args: unknown[]) => Promise<unknown>>() },
			};
			userListService = {
				membersCache: { fetch: jest.fn<(...args: unknown[]) => Promise<unknown>>() },
			};

		idService.parseFull.mockImplementation((id: unknown) => ({
			date: id === 'since-id' ? 1000 : 2000,
			additional: id === 'since-id' ? 1n : 2n,
		}));
	});

	test('falls back to the notification extension when Redis has no notifications', async () => {
		const notification = {
			id: 'notification-id',
			type: 'reaction',
			createdAt: '2026-07-01T00:00:00.000Z',
			notifierId: 'actor-id',
			noteId: 'note-id',
			reaction: ':test:',
		} satisfies MiNotification;
		redisClient.xrevrange.mockResolvedValue([]);
		httpRequestService.send.mockResolvedValue(response([notification]));
		const service = createService();

		const result = await service.getNotifications('target-user-id', {
			sinceId: 'since-id',
			untilId: 'until-id',
			limit: 10,
			includeTypes: ['reaction'],
			excludeTypes: ['follow'],
		});

		expect(result).toEqual([notification]);
		expect(httpRequestService.send).toHaveBeenCalledTimes(1);
		const [url, args, extra] = firstSendCall();
		const parsedUrl = new URL(url);
		expect(`${parsedUrl.origin}${parsedUrl.pathname}`).toBe('https://notification-extension.example/api/v1/notifications');
		expect(parsedUrl.searchParams.get('userId')).toBe('target-user-id');
		expect(parsedUrl.searchParams.get('sinceId')).toBe('since-id');
		expect(parsedUrl.searchParams.get('untilId')).toBe('until-id');
		expect(parsedUrl.searchParams.get('limit')).toBe('10');
		expect(parsedUrl.searchParams.getAll('includeTypes')).toEqual(['reaction']);
		expect(parsedUrl.searchParams.getAll('excludeTypes')).toEqual(['follow']);
		expect(args.method).toBe('GET');
		expect(args.timeout).toBe(1234);
		expect(args.isLocalAddressAllowed).toBe(true);
		expect(args.headers?.Authorization).toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/);
		expect(extra.throwErrorWhenResponseNotOk).toBe(false);
	});

	test('replicates created notifications to the notification extension', async () => {
		cacheService.userProfileCache.fetch.mockResolvedValue({ notificationRecieveConfig: {} });
		idService.gen.mockReturnValue('notification-id');
		redisClient.xadd.mockResolvedValue('2000-2');
		redisClient.get.mockResolvedValue(null);
		notificationEntityService.pack.mockResolvedValue({ id: 'notification-id' });
		httpRequestService.send.mockResolvedValue(response());
		const service = createService();

		service.createNotification('target-user-id', 'test', {});
		await allSettled();

		expect(httpRequestService.send).toHaveBeenCalledTimes(1);
		const [url, args, extra] = firstSendCall();
		expect(url).toBe('https://notification-extension.example/api/v1/notifications');
		expect(args.method).toBe('POST');
		expect(args.timeout).toBe(1234);
		expect(args.isLocalAddressAllowed).toBe(true);
		expect(args.headers?.Authorization).toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/);
		expect(args.headers?.['Content-Type']).toBe('application/json');
		expect(JSON.parse(args.body as string)).toMatchObject({
			id: 'notification-id',
			type: 'test',
			notifieeId: 'target-user-id',
			isRead: false,
		});
		expect(extra.throwErrorWhenResponseNotOk).toBe(false);
	});

	test('deletes persisted notifications for the user when notifications are flushed', async () => {
		redisClient.del.mockResolvedValue(1);
		httpRequestService.send.mockResolvedValue(response());
		const service = createService();

		await service.flushAllNotifications('target-user-id');

		expect(httpRequestService.send).toHaveBeenCalledTimes(1);
		const [url, args, extra] = firstSendCall();
		const parsedUrl = new URL(url);
		expect(`${parsedUrl.origin}${parsedUrl.pathname}`).toBe('https://notification-extension.example/api/v1/notifications');
		expect(parsedUrl.searchParams.get('userId')).toBe('target-user-id');
		expect(args.method).toBe('DELETE');
		expect(args.timeout).toBe(1234);
		expect(args.isLocalAddressAllowed).toBe(true);
		expect(args.headers?.Authorization).toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/);
		expect(extra.throwErrorWhenResponseNotOk).toBe(false);
	});
});
