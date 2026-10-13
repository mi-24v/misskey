/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHmac } from 'node:crypto';
import * as dns from 'node:dns';
import * as http from 'node:http';
import * as https from 'node:https';
import fetch from 'node-fetch';
import { Inject, Injectable, OnApplicationShutdown, Optional } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { bindThis } from '@/decorators.js';
import type * as net from 'node:net';
import type { Response } from 'node-fetch';

export type NotificationExtensionAgentOptions = {
	lookup?: net.LookupFunction;
	/** テストで private CA を注入するときだけ指定する */
	ca?: string | Buffer | Array<string | Buffer>;
};

export const NOTIFICATION_EXTENSION_AGENT_OPTIONS = Symbol('NotificationExtensionAgentOptions');

const NOTIFICATIONS_PATH = '/api/v1/notifications';

/**
 * 通知 extension 専用の agent を作る。
 * 汎用の HttpRequestService と違い、proxy・cacheable-lookup・outgoingAddress・私設 IP フィルターを使わず、
 * OS の dns.lookup と既定の TLS 検証で設定済みの origin にだけ接続する。
 */
export function createNotificationExtensionAgent(origin: URL, options: NotificationExtensionAgentOptions = {}): http.Agent | https.Agent {
	const agentOptions = {
		keepAlive: true,
		keepAliveMsecs: 30 * 1000,
		lookup: options.lookup ?? dns.lookup,
	};

	switch (origin.protocol) {
		case 'http:':
			return new http.Agent(agentOptions);
		case 'https:':
			return new https.Agent({
				...agentOptions,
				...(options.ca !== undefined ? { ca: options.ca } : {}),
			});
		default:
			throw new Error('Notification extension origin must use http or https.');
	}
}

@Injectable()
export class NotificationExtensionClient implements OnApplicationShutdown {
	private readonly agent: http.Agent | https.Agent | undefined;

	constructor(
		@Inject(DI.config)
		private config: Config,

		@Optional()
		@Inject(NOTIFICATION_EXTENSION_AGENT_OPTIONS)
		agentOptions?: NotificationExtensionAgentOptions,
	) {
		const extension = config.notificationExtension;
		this.agent = extension ? createNotificationExtensionAgent(new URL(extension.baseUrl), agentOptions) : undefined;
	}

	private createToken(secret: string): string {
		const now = Math.floor(Date.now() / 1000);
		const header = Buffer.from(JSON.stringify({
			alg: 'HS256',
			typ: 'JWT',
		})).toString('base64url');
		const payload = Buffer.from(JSON.stringify({
			iss: 'misskey',
			sub: 'notification-extension',
			iat: now,
			exp: now + 60,
		})).toString('base64url');
		const unsigned = `${header}.${payload}`;
		const signature = createHmac('sha256', secret).update(unsigned).digest('base64url');
		return `${unsigned}.${signature}`;
	}

	/**
	 * 設定済み origin の /api/v1/notifications にだけ送信する。
	 * 失敗（接続・TLS・timeout など）は例外にせず null を返す。リダイレクトは追従しない。
	 */
	@bindThis
	public async request(
		method: 'GET' | 'POST' | 'DELETE',
		params?: URLSearchParams,
		body?: unknown,
	): Promise<Response | null> {
		const extension = this.config.notificationExtension;
		if (!extension || !this.agent) return null;

		const url = new URL(NOTIFICATIONS_PATH, extension.baseUrl);
		for (const [key, value] of params ?? []) {
			url.searchParams.append(key, value);
		}

		try {
			return await fetch(url, {
				method,
				headers: {
					'User-Agent': this.config.userAgent,
					Accept: 'application/json',
					Authorization: `Bearer ${this.createToken(extension.secret)}`,
					...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
				},
				body: body !== undefined ? JSON.stringify(body) : undefined,
				redirect: 'manual',
				size: 1024 * 256,
				agent: this.agent,
				// 本文の読み取りも含めて timeout で中断する
				signal: AbortSignal.timeout(extension.timeoutMs ?? 5000),
			});
		} catch {
			return null;
		}
	}

	@bindThis
	public onApplicationShutdown(): void {
		this.agent?.destroy();
	}
}
