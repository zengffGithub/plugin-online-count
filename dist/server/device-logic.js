/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var device_logic_exports = {};
__export(device_logic_exports, {
  computeEnforceSingleDevice: () => computeEnforceSingleDevice,
  computeKickOnNewConnection: () => computeKickOnNewConnection
});
module.exports = __toCommonJS(device_logic_exports);
function computeKickOnNewConnection(input) {
  const { newClientId, newDeviceId, existingClientIds, clientDeviceId } = input;
  if (!newDeviceId) return { toKick: [] };
  const toKick = [];
  for (const cid of existingClientIds) {
    if (cid === newClientId) continue;
    const dev = clientDeviceId.get(cid);
    if (dev && dev !== newDeviceId) {
      toKick.push(cid);
    }
  }
  return { toKick };
}
function computeEnforceSingleDevice(input) {
  const { existingClientIds, clientDeviceId, clientPingTimes } = input;
  const groups = /* @__PURE__ */ new Map();
  for (const cid of existingClientIds) {
    const dev = clientDeviceId.get(cid);
    if (!dev) continue;
    const arr = groups.get(dev);
    if (arr) arr.push(cid);
    else groups.set(dev, [cid]);
  }
  const knownDevices = Array.from(groups.keys());
  if (knownDevices.length < 2) return { toKick: [] };
  let winnerDevice = knownDevices[0];
  let winnerPing = -1;
  for (const dev of knownDevices) {
    for (const cid of groups.get(dev) ?? []) {
      const ping = clientPingTimes.get(cid) ?? 0;
      if (ping > winnerPing) {
        winnerPing = ping;
        winnerDevice = dev;
      }
    }
  }
  const toKick = [];
  for (const dev of knownDevices) {
    if (dev === winnerDevice) continue;
    toKick.push(...groups.get(dev) ?? []);
  }
  return { toKick };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  computeEnforceSingleDevice,
  computeKickOnNewConnection
});
