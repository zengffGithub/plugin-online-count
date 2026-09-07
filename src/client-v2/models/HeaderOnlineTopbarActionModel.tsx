import { TeamOutlined } from '@ant-design/icons';
import { TopbarActionModel } from '@nocobase/client-v2';
import React from 'react';
import { HeaderOnlineIcon } from '../components/HeaderOnlineIcon';
import { tExpr } from '../locale';

export class HeaderOnlineTopbarActionModel extends TopbarActionModel {
  sort = 20;
  actionId = 'online-count';
  testId = 'online-count-button';
  icon = (<TeamOutlined />);
  tooltip = tExpr('Online users');

  render() {
    return <HeaderOnlineIcon />;
  }
}

export default HeaderOnlineTopbarActionModel;
