/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, jest, test } from '@jest/globals';
import { resolveNotificationExtensionConfig } from './config.js';

describe('resolveNotificationExtensionConfig', () => {
	test('uses environment-only configuration', () => {
		const warn = jest.fn();

		const result = resolveNotificationExtensionConfig(undefined, {
			NOTIFICATION_EXTENSION_URL: 'https://extension.example/',
			NOTIFICATION_EXTENSION_SECRET: 'env-secret',
		}, warn);

		expect(result).toEqual({
			baseUrl: 'https://extension.example',
			secret: 'env-secret',
			timeoutMs: undefined,
		});
		expect(warn).not.toHaveBeenCalled();
	});

	test('falls back to YAML configuration', () => {
		const warn = jest.fn();

		const result = resolveNotificationExtensionConfig({
			baseUrl: 'https://yaml-extension.example/',
			secret: 'yaml-secret',
			timeoutMs: 1234,
		}, {}, warn);

		expect(result).toEqual({
			baseUrl: 'https://yaml-extension.example',
			secret: 'yaml-secret',
			timeoutMs: 1234,
		});
		expect(warn).not.toHaveBeenCalled();
	});

	test('lets environment variables override YAML configuration', () => {
		const warn = jest.fn();

		const result = resolveNotificationExtensionConfig({
			baseUrl: 'https://yaml-extension.example',
			secret: 'yaml-secret',
			timeoutMs: 1234,
		}, {
			NOTIFICATION_EXTENSION_URL: 'https://env-extension.example/',
			NOTIFICATION_EXTENSION_SECRET: 'env-secret',
		}, warn);

		expect(result).toEqual({
			baseUrl: 'https://env-extension.example',
			secret: 'env-secret',
			timeoutMs: 1234,
		});
		expect(warn).not.toHaveBeenCalled();
	});

	test('does not mix partial environment configuration with YAML fallback', () => {
		const warn = jest.fn();

		const result = resolveNotificationExtensionConfig({
			baseUrl: 'https://yaml-extension.example',
			secret: 'yaml-secret',
			timeoutMs: 1234,
		}, {
			NOTIFICATION_EXTENSION_URL: 'https://env-extension.example',
		}, warn);

		expect(result).toBeUndefined();
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0][0]).not.toContain('https://env-extension.example');
		expect(warn.mock.calls[0][0]).not.toContain('yaml-secret');
	});

	test('disables the integration when neither source is configured', () => {
		const warn = jest.fn();

		const result = resolveNotificationExtensionConfig(undefined, {}, warn);

		expect(result).toBeUndefined();
		expect(warn).not.toHaveBeenCalled();
	});

	test('disables the integration and warns when only URL is configured', () => {
		const warn = jest.fn();

		const result = resolveNotificationExtensionConfig(undefined, {
			NOTIFICATION_EXTENSION_URL: 'https://extension.example',
		}, warn);

		expect(result).toBeUndefined();
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0][0]).not.toContain('https://extension.example');
	});

	test('disables the integration and warns when only secret is configured', () => {
		const warn = jest.fn();

		const result = resolveNotificationExtensionConfig(undefined, {
			NOTIFICATION_EXTENSION_SECRET: 'env-secret',
		}, warn);

		expect(result).toBeUndefined();
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0][0]).not.toContain('env-secret');
	});
});
