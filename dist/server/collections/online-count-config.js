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
var online_count_config_exports = {};
__export(online_count_config_exports, {
  default: () => online_count_config_default
});
module.exports = __toCommonJS(online_count_config_exports);
var import_database = require("@nocobase/database");
var online_count_config_default = (0, import_database.defineCollection)({
  name: "onlineCountConfig",
  title: "Online Count Config",
  autoGenId: false,
  fields: [
    {
      type: "string",
      name: "key",
      primaryKey: true
    },
    {
      type: "boolean",
      name: "visibleToAll",
      defaultValue: true
    },
    {
      type: "boolean",
      name: "singleSession",
      defaultValue: false
    }
  ]
});
