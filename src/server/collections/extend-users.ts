import { extendCollection } from '@nocobase/database';

export default extendCollection({
  name: 'users',
  fields: [
    {
      type: 'boolean',
      name: 'blacklisted',
      defaultValue: false,
    },
  ],
});
