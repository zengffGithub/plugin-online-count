import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'userBroadcastReads',
  title: 'User Broadcast Reads',
  indexes: [{ unique: true, fields: ['userId', 'broadcastId'] }],
  fields: [
    {
      type: 'belongsTo',
      name: 'user',
      target: 'users',
      foreignKey: 'userId',
    },
    {
      type: 'integer',
      name: 'broadcastId',
    },
    {
      type: 'date',
      name: 'readAt',
    },
  ],
});
