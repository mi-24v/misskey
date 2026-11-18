/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import { describe, expect, jest, test } from '@jest/globals';
import { resolveNotificationExtensionConfig } from '@/config.js';

const secret = 'test-only-shared-secret';

describe('resolveNotificationExtensionConfig', () => {
	test('accepts https and http origins and normalizes to origin', () => {
		const warn = jest.fn<(message: string) => void>();

		expect(resolveNotificationExtensionConfig(undefined, {
			NOTIFICATION_EXTENSION_URL: 'https://ext.example.test:8080/',
			NOTIFICATION_EXTENSION_SECRET: secret,
		}, warn)).toEqual({
			baseUrl: 'https://ext.example.test:8080',
			secret,
			timeoutMs: undefined,
		});

		expect(resolveNotificationExtensionConfig({
			baseUrl: 'http://localhost:8080',
			secret,
			timeoutMs: 1234,
		}, {}, warn)).toEqual({
			baseUrl: 'http://localhost:8080',
			secret,
			timeoutMs: 1234,
		});

		expect(warn).not.toHaveBeenCalled();
	});

	test.each([
		'ftp://ext.example.test',
		'https://user:pass@ext.example.test',
		'https://ext.example.test/api',
		'https://ext.example.test/?x=1',
		'https://ext.example.test/#f',
		'not a url',
	])('rejects %s', (baseUrl) => {
		const warn = jest.fn<(message: string) => void>();

		const result = resolveNotificationExtensionConfig(undefined, {
			NOTIFICATION_EXTENSION_URL: baseUrl,
			NOTIFICATION_EXTENSION_SECRET: secret,
		}, warn);

		expect(result).toBeUndefined();
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0][0]).not.toContain(secret);
	});

	test('keeps env-over-yaml precedence and incomplete-config warning', () => {
		const warn = jest.fn<(message: string) => void>();
		const source = {
			baseUrl: 'https://yaml.example.test',
			secret: 'yaml-secret',
			timeoutMs: 1000,
		};

		// 環境変数が 1 つでもあれば yaml の値は使わない
		expect(resolveNotificationExtensionConfig(source, {
			NOTIFICATION_EXTENSION_URL: 'https://env.example.test',
			NOTIFICATION_EXTENSION_SECRET: secret,
		}, warn)).toEqual({
			baseUrl: 'https://env.example.test',
			secret,
			timeoutMs: 1000,
		});
		expect(warn).not.toHaveBeenCalled();

		expect(resolveNotificationExtensionConfig(source, {
			NOTIFICATION_EXTENSION_URL: 'https://env.example.test',
		}, warn)).toBeUndefined();
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0][0]).toContain('incomplete');

		// 空文字列は未設定として扱う
		expect(resolveNotificationExtensionConfig(source, {
			NOTIFICATION_EXTENSION_URL: '',
			NOTIFICATION_EXTENSION_SECRET: '',
		}, warn)).toEqual({
			baseUrl: 'https://yaml.example.test',
			secret: 'yaml-secret',
			timeoutMs: 1000,
		});

		expect(resolveNotificationExtensionConfig(undefined, {}, warn)).toBeUndefined();
		expect(warn).toHaveBeenCalledTimes(1);
	});
});
