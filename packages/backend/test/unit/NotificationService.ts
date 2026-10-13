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
import type { NotificationExtensionClient } from '@/core/NotificationExtensionClient.js';
import { allSettled } from '@/misc/promise-tracker.js';
import type { MiNotification } from '@/models/Notification.js';

type AsyncMock = jest.Mock<(...args: unknown[]) => Promise<unknown>>;
type SyncMock = jest.Mock<(...args: unknown[]) => unknown>;
type ExtensionRequestCall = Parameters<NotificationExtensionClient['request']>;

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
	let notificationExtensionClient: jest.Mocked<NotificationExtensionClient>;
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

	function firstRequestCall(): ExtensionRequestCall {
		expect(notificationExtensionClient.request).toHaveBeenCalled();
		return notificationExtensionClient.request.mock.calls[0];
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
			notificationExtensionClient,
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
			notificationExtensionClient = {
				request: jest.fn(),
			} as unknown as jest.Mocked<NotificationExtensionClient>;
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
		notificationExtensionClient.request.mockResolvedValue(response([notification]));
		const service = createService();

		const result = await service.getNotifications('target-user-id', {
			sinceId: 'since-id',
			untilId: 'until-id',
			limit: 10,
			includeTypes: ['reaction'],
			excludeTypes: ['follow'],
		});

		expect(result).toEqual([notification]);
		expect(notificationExtensionClient.request).toHaveBeenCalledTimes(1);
		const [method, params, body] = firstRequestCall();
		expect(method).toBe('GET');
		expect(params?.get('userId')).toBe('target-user-id');
		expect(params?.get('sinceId')).toBe('since-id');
		expect(params?.get('untilId')).toBe('until-id');
		expect(params?.get('limit')).toBe('10');
		expect(params?.getAll('includeTypes')).toEqual(['reaction']);
		expect(params?.getAll('excludeTypes')).toEqual(['follow']);
		expect(body).toBeUndefined();
	});

	test('replicates created notifications to the notification extension', async () => {
		cacheService.userProfileCache.fetch.mockResolvedValue({ notificationRecieveConfig: {} });
		idService.gen.mockReturnValue('notification-id');
		redisClient.xadd.mockResolvedValue('2000-2');
		redisClient.get.mockResolvedValue(null);
		notificationEntityService.pack.mockResolvedValue({ id: 'notification-id' });
		notificationExtensionClient.request.mockResolvedValue(response());
		const service = createService();

		service.createNotification('target-user-id', 'test', {});
		await allSettled();

		expect(notificationExtensionClient.request).toHaveBeenCalledTimes(1);
		const [method, params, body] = firstRequestCall();
		expect(method).toBe('POST');
		expect(params).toBeUndefined();
		expect(body).toMatchObject({
			id: 'notification-id',
			type: 'test',
			notifieeId: 'target-user-id',
			isRead: false,
		});
	});

	test('deletes persisted notifications for the user when notifications are flushed', async () => {
		redisClient.del.mockResolvedValue(1);
		notificationExtensionClient.request.mockResolvedValue(response());
		const service = createService();

		await service.flushAllNotifications('target-user-id');

		expect(notificationExtensionClient.request).toHaveBeenCalledTimes(1);
		const [method, params, body] = firstRequestCall();
		expect(method).toBe('DELETE');
		expect(params?.get('userId')).toBe('target-user-id');
		expect(body).toBeUndefined();
	});
});
