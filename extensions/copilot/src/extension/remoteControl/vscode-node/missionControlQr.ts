/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const enum QrMaskPattern {
	Pattern0 = 0,
	Pattern1 = 1,
	Pattern2 = 2,
	Pattern3 = 3,
	Pattern4 = 4,
	Pattern5 = 5,
	Pattern6 = 6,
	Pattern7 = 7,
}

const qrVersion = 6;
const qrSize = 17 + 4 * qrVersion;
const qrDataCodewords = 108;
const qrDataBlocks = 4;
const qrDataCodewordsPerBlock = 27;
const qrErrorCodewordsPerBlock = 16;
const qrQuietZoneModules = 4;
const qrSvgModuleSize = 5;

const qrGfExp = new Array<number>(512);
const qrGfLog = new Array<number>(256);

function initializeQrGaloisField(): void {
	if (qrGfExp[0] !== undefined) {
		return;
	}

	let value = 1;
	for (let i = 0; i < 255; i++) {
		qrGfExp[i] = value;
		qrGfLog[value] = i;
		value <<= 1;
		if (value & 0x100) {
			value ^= 0x11d;
		}
	}
	for (let i = 255; i < qrGfExp.length; i++) {
		qrGfExp[i] = qrGfExp[i - 255];
	}
}

function qrGfMultiply(a: number, b: number): number {
	if (!a || !b) {
		return 0;
	}
	return qrGfExp[qrGfLog[a] + qrGfLog[b]];
}

function getQrGeneratorPolynomial(degree: number): number[] {
	initializeQrGaloisField();

	let polynomial = [1];
	for (let i = 0; i < degree; i++) {
		const next = new Array<number>(polynomial.length + 1).fill(0);
		for (let j = 0; j < polynomial.length; j++) {
			next[j] ^= polynomial[j];
			next[j + 1] ^= qrGfMultiply(polynomial[j], qrGfExp[i]);
		}
		polynomial = next;
	}
	return polynomial.slice(1);
}

function getQrErrorCodewords(data: number[], degree: number): number[] {
	const generator = getQrGeneratorPolynomial(degree);
	const result = new Array<number>(degree).fill(0);
	for (const codeword of data) {
		const factor = codeword ^ result[0];
		result.shift();
		result.push(0);
		for (let i = 0; i < degree; i++) {
			result[i] ^= qrGfMultiply(generator[i], factor);
		}
	}
	return result;
}

function appendQrBits(bits: boolean[], value: number, length: number): void {
	for (let i = length - 1; i >= 0; i--) {
		bits.push(((value >>> i) & 1) === 1);
	}
}

function getQrDataCodewords(data: string): number[] {
	const bytes = Array.from(Buffer.from(data, 'utf8'));
	if (bytes.length > 106) {
		throw new Error('Remote control URL is too long to render as a QR code.');
	}

	const bits: boolean[] = [];
	appendQrBits(bits, 0b0100, 4);
	appendQrBits(bits, bytes.length, 8);
	for (const byte of bytes) {
		appendQrBits(bits, byte, 8);
	}

	for (let i = 0; i < 4 && bits.length < qrDataCodewords * 8; i++) {
		bits.push(false);
	}
	while (bits.length % 8 !== 0) {
		bits.push(false);
	}

	const codewords: number[] = [];
	for (let i = 0; i < bits.length; i += 8) {
		let codeword = 0;
		for (let j = 0; j < 8; j++) {
			codeword = (codeword << 1) | (bits[i + j] ? 1 : 0);
		}
		codewords.push(codeword);
	}

	for (let pad = 0; codewords.length < qrDataCodewords; pad++) {
		codewords.push(pad % 2 === 0 ? 0xec : 0x11);
	}
	return codewords;
}

function getQrCodewords(data: string): number[] {
	const dataCodewords = getQrDataCodewords(data);
	const blocks: { data: number[]; error: number[] }[] = [];
	for (let i = 0; i < qrDataBlocks; i++) {
		const blockData = dataCodewords.slice(i * qrDataCodewordsPerBlock, (i + 1) * qrDataCodewordsPerBlock);
		blocks.push({ data: blockData, error: getQrErrorCodewords(blockData, qrErrorCodewordsPerBlock) });
	}

	const result: number[] = [];
	for (let i = 0; i < qrDataCodewordsPerBlock; i++) {
		for (const block of blocks) {
			result.push(block.data[i]);
		}
	}
	for (let i = 0; i < qrErrorCodewordsPerBlock; i++) {
		for (const block of blocks) {
			result.push(block.error[i]);
		}
	}
	return result;
}

function createQrMatrix(): { modules: boolean[][]; reserved: boolean[][] } {
	const modules = Array.from({ length: qrSize }, () => new Array<boolean>(qrSize).fill(false));
	const reserved = Array.from({ length: qrSize }, () => new Array<boolean>(qrSize).fill(false));
	const setModule = (x: number, y: number, dark: boolean) => {
		if (x < 0 || y < 0 || x >= qrSize || y >= qrSize) {
			return;
		}
		modules[y][x] = dark;
		reserved[y][x] = true;
	};
	const addFinder = (x: number, y: number) => {
		for (let dy = -1; dy <= 7; dy++) {
			for (let dx = -1; dx <= 7; dx++) {
				const isPattern = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6
					&& (dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
				setModule(x + dx, y + dy, isPattern);
			}
		}
	};

	addFinder(0, 0);
	addFinder(qrSize - 7, 0);
	addFinder(0, qrSize - 7);

	for (let i = 8; i < qrSize - 8; i++) {
		setModule(i, 6, i % 2 === 0);
		setModule(6, i, i % 2 === 0);
	}

	for (let dy = -2; dy <= 2; dy++) {
		for (let dx = -2; dx <= 2; dx++) {
			setModule(34 + dx, 34 + dy, Math.max(Math.abs(dx), Math.abs(dy)) === 2 || (dx === 0 && dy === 0));
		}
	}

	setModule(8, 4 * qrVersion + 9, true);

	for (let i = 0; i <= 8; i++) {
		if (i !== 6) {
			setModule(8, i, false);
			setModule(i, 8, false);
		}
	}
	for (let i = 0; i < 8; i++) {
		setModule(qrSize - 1 - i, 8, false);
	}
	for (let i = 0; i < 7; i++) {
		setModule(8, qrSize - 1 - i, false);
	}

	return { modules, reserved };
}

function getQrMask(mask: QrMaskPattern, x: number, y: number): boolean {
	switch (mask) {
		case QrMaskPattern.Pattern0: return (x + y) % 2 === 0;
		case QrMaskPattern.Pattern1: return y % 2 === 0;
		case QrMaskPattern.Pattern2: return x % 3 === 0;
		case QrMaskPattern.Pattern3: return (x + y) % 3 === 0;
		case QrMaskPattern.Pattern4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
		case QrMaskPattern.Pattern5: return ((x * y) % 2) + ((x * y) % 3) === 0;
		case QrMaskPattern.Pattern6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
		case QrMaskPattern.Pattern7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
	}
}

function setQrFormatInfo(modules: boolean[][], mask: QrMaskPattern): void {
	let format = mask;
	let remainder = format << 10;
	for (let i = 14; i >= 10; i--) {
		if (((remainder >>> i) & 1) !== 0) {
			remainder ^= 0x537 << (i - 10);
		}
	}
	format = ((format << 10) | remainder) ^ 0x5412;

	const setBit = (x: number, y: number, bitIndex: number) => {
		modules[y][x] = ((format >>> bitIndex) & 1) !== 0;
	};
	for (let i = 0; i <= 5; i++) {
		setBit(8, i, i);
	}
	setBit(8, 7, 6);
	setBit(8, 8, 7);
	setBit(7, 8, 8);
	for (let i = 9; i < 15; i++) {
		setBit(14 - i, 8, i);
	}
	for (let i = 0; i < 8; i++) {
		setBit(qrSize - 1 - i, 8, i);
	}
	for (let i = 8; i < 15; i++) {
		setBit(8, qrSize - 15 + i, i);
	}
}

function getQrPenalty(modules: boolean[][]): number {
	let penalty = 0;
	const scoreRuns = (line: boolean[]) => {
		let runColor = line[0];
		let runLength = 1;
		for (let i = 1; i <= line.length; i++) {
			if (i < line.length && line[i] === runColor) {
				runLength++;
			} else {
				if (runLength >= 5) {
					penalty += 3 + runLength - 5;
				}
				runColor = line[i];
				runLength = 1;
			}
		}
	};

	for (let y = 0; y < qrSize; y++) {
		scoreRuns(modules[y]);
	}
	for (let x = 0; x < qrSize; x++) {
		scoreRuns(modules.map(row => row[x]));
	}

	for (let y = 0; y < qrSize - 1; y++) {
		for (let x = 0; x < qrSize - 1; x++) {
			const color = modules[y][x];
			if (modules[y][x + 1] === color && modules[y + 1][x] === color && modules[y + 1][x + 1] === color) {
				penalty += 3;
			}
		}
	}

	const finderPattern = '10111010000';
	const reverseFinderPattern = '00001011101';
	const scoreFinderPattern = (line: boolean[]) => {
		const text = line.map(bit => bit ? '1' : '0').join('');
		for (let i = 0; i <= text.length - finderPattern.length; i++) {
			const slice = text.slice(i, i + finderPattern.length);
			if (slice === finderPattern || slice === reverseFinderPattern) {
				penalty += 40;
			}
		}
	};
	for (let y = 0; y < qrSize; y++) {
		scoreFinderPattern(modules[y]);
	}
	for (let x = 0; x < qrSize; x++) {
		scoreFinderPattern(modules.map(row => row[x]));
	}

	const darkModules = modules.flat().filter(Boolean).length;
	const darkPercent = darkModules * 100 / (qrSize * qrSize);
	penalty += Math.floor(Math.abs(darkPercent - 50) / 5) * 10;
	return penalty;
}

function buildQrMatrix(data: string): boolean[][] {
	const codewordBits = getQrCodewords(data).flatMap(codeword => {
		const bits: boolean[] = [];
		appendQrBits(bits, codeword, 8);
		return bits;
	});

	let bestModules: boolean[][] | undefined;
	let bestPenalty = Number.MAX_SAFE_INTEGER;
	for (let mask = 0; mask <= 7; mask++) {
		const { modules, reserved } = createQrMatrix();
		let bitIndex = 0;
		let upward = true;
		for (let right = qrSize - 1; right >= 1; right -= 2) {
			if (right === 6) {
				right--;
			}
			for (let vertical = 0; vertical < qrSize; vertical++) {
				const y = upward ? qrSize - 1 - vertical : vertical;
				for (let column = 0; column < 2; column++) {
					const x = right - column;
					if (reserved[y][x]) {
						continue;
					}
					const bit = bitIndex < codewordBits.length ? codewordBits[bitIndex++] : false;
					modules[y][x] = bit !== getQrMask(mask, x, y);
				}
			}
			upward = !upward;
		}

		setQrFormatInfo(modules, mask);
		const penalty = getQrPenalty(modules);
		if (penalty < bestPenalty) {
			bestPenalty = penalty;
			bestModules = modules;
		}
	}

	if (!bestModules) {
		throw new Error('Unable to render QR code.');
	}
	return bestModules;
}

export async function renderRemoteControlQrCode(data: string): Promise<string> {
	const modules = buildQrMatrix(data);
	const imageSize = (qrSize + qrQuietZoneModules * 2) * qrSvgModuleSize;
	const path = modules.flatMap((row, y) => row.map((dark, x) => {
		if (!dark) {
			return '';
		}
		const moduleX = (x + qrQuietZoneModules) * qrSvgModuleSize;
		const moduleY = (y + qrQuietZoneModules) * qrSvgModuleSize;
		return `M${moduleX} ${moduleY}h${qrSvgModuleSize}v${qrSvgModuleSize}h-${qrSvgModuleSize}z`;
	})).join('');
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${imageSize} ${imageSize}" width="${imageSize}" height="${imageSize}"><path fill="#fff" d="M0 0h${imageSize}v${imageSize}H0z"/><path fill="#000" d="${path}"/></svg>`;
	return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}
