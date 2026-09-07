import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'onlineCountConfig',
  title: 'Online Count Config',
  autoGenId: false,
  fields: [
    {
      type: 'string',
      name: 'key',
      primaryKey: true,
    },
    {
      type: 'boolean',
      name: 'visibleToAll',
      defaultValue: true,
    },
    {
      type: 'boolean',
      name: 'singleSession',
      defaultValue: false,
    },
  ],
});
