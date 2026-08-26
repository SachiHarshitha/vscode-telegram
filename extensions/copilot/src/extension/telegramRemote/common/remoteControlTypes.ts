/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Compatibility re-export for Telegram adapter code while the transport-neutral framework
// lives under extension/remoteControl. New generic consumers must import the framework directly.
export * from '../../remoteControl/common/remoteControlTypes';
