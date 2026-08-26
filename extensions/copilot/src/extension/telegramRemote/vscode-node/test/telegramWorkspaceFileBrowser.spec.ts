/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
import { FileType } from '../../../../platform/filesystem/common/fileTypes';
import { MockFileSystemService } from '../../../../platform/filesystem/node/test/mockFileSystemService';
import { URI } from '../../../../util/vs/base/common/uri';
import { TelegramWorkspaceFileBrowserImpl } from '../telegramWorkspaceFileBrowser';

describe('TelegramWorkspaceFileBrowserImpl', () => {
	it('lists only ordinary files and directories inside the selected workspace', async () => {
		const fileSystem = new MockFileSystemService();
		const root = URI.file('C:\\workspace');
		fileSystem.mockDirectory(root, [
			['z.txt', FileType.File],
			['src', FileType.Directory],
			['linked.txt', FileType.File | FileType.SymbolicLink],
		]);
		const browser = new TelegramWorkspaceFileBrowserImpl(fileSystem);

		const directory = await browser.listDirectory(root.toString(), '');

		expect(directory).toEqual({
			relativePath: '',
			entries: [
				{ id: 'src', label: 'src', kind: 'directory' },
				{ id: 'z.txt', label: 'z.txt', kind: 'file' },
			],
		});
	});

	it('rejects absolute paths and traversal before touching the filesystem', async () => {
		const fileSystem = new MockFileSystemService();
		const readDirectory = vi.spyOn(fileSystem, 'readDirectory');
		const browser = new TelegramWorkspaceFileBrowserImpl(fileSystem);

		await expect(browser.listDirectory(URI.file('C:\\workspace').toString(), '../secret')).rejects.toThrow('invalid');
		await expect(browser.listDirectory(URI.file('C:\\workspace').toString(), '/secret')).rejects.toThrow('invalid');
		expect(readDirectory).not.toHaveBeenCalled();
	});

	it('bounds text previews and rejects binary content', async () => {
		const fileSystem = new MockFileSystemService();
		const browser = new TelegramWorkspaceFileBrowserImpl(fileSystem);
		const root = URI.file('C:\\workspace').toString();
		vi.spyOn(fileSystem, 'readFile').mockResolvedValueOnce(new TextEncoder().encode('x'.repeat(40_000)));

		const preview = await browser.readFile(root, 'large.txt');
		expect({ length: preview.text.length, truncated: preview.truncated }).toEqual({ length: 32_000, truncated: true });
		vi.spyOn(fileSystem, 'readFile').mockResolvedValueOnce(new TextEncoder().encode(`${'a'.repeat(31_999)}😀tail`));
		await expect(browser.readFile(root, 'utf8-boundary.txt')).resolves.toMatchObject({ text: 'a'.repeat(31_999), truncated: true });

		vi.spyOn(fileSystem, 'readFile').mockResolvedValueOnce(new Uint8Array([1, 0, 2]));
		await expect(browser.readFile(root, 'binary.dat')).rejects.toThrow('Binary');

		vi.spyOn(fileSystem, 'readFile').mockResolvedValueOnce(new Uint8Array([0xFF, 0xFE, 0xFD]));
		await expect(browser.readFile(root, 'invalid-utf8.dat')).rejects.toThrow('Binary');
	});
});
