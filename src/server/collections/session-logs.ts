import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'sessionLogs',
  title: 'Session Logs',
  fields: [
    {
      type: 'belongsTo',
      name: 'user',
      target: 'users',
      foreignKey: 'userId',
    },
    {
      type: 'date',
      name: 'loginTime',
    },
    {
      type: 'date',
      name: 'logoutTime',
    },
    {
      type: 'integer',
      name: 'duration',
    },
    {
      type: 'string',
      name: 'logoutReason',
    },
    {
      type: 'string',
      name: 'ip',
    },
    {
      type: 'text',
      name: 'userAgent',
    },
    {
      type: 'string',
      name: 'status',
    },
  ],
});
