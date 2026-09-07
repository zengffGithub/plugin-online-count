import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'systemBroadcasts',
  title: 'System Broadcasts',
  fields: [
    {
      type: 'text',
      name: 'content',
    },
    {
      type: 'string',
      name: 'msgType',
      defaultValue: 'info',
    },
    {
      type: 'string',
      name: 'sender',
    },
    {
      type: 'date',
      name: 'expiresAt',
    },
  ],
});
