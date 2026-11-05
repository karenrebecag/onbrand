import type { ConnectorAccount, ConnectorApp } from '@/lib/run-client'

// Solo para ver la UI sin transport; slugs e iconos son los que devuelve Pipedream por el transport.
const icon = (id: string) => `https://assets.pipedream.net/s.v0/${id}/logo/orig`

export const fixtureApps: ConnectorApp[] = [
  { slug: 'notion', name: 'Notion', description: 'Pages, databases and docs for your team.', icon: icon('app_X7Lhxr') },
  { slug: 'google_drive', name: 'Google Drive', description: 'Files and folders in your Drive.', icon: icon('app_1lxhk1') },
  { slug: 'github', name: 'GitHub', description: 'Repositories, issues and pull requests.', icon: icon('app_OrZhaO') },
  { slug: 'google_docs', name: 'Google Docs', description: 'Create and edit documents online.', icon: icon('app_1pbh98') },
  { slug: 'airtable_oauth', name: 'Airtable', description: 'Spreadsheet-database hybrid for teams.', icon: icon('app_XBxhAl') },
  { slug: 'hubspot', name: 'HubSpot', description: 'CRM, marketing and sales platform.', icon: icon('app_OkrhlP') },
  { slug: 'slack_v2', name: 'Slack', description: 'Channels and messages for your team.', icon: icon('app_M0hv7G') },
]

export const fixtureAccounts: ConnectorAccount[] = [
  { id: 'apn_fixture1', app: 'notion', name: 'Demo workspace', state: 'connected' },
  { id: 'apn_fixture2', app: 'hubspot', name: null, state: 'reconnect' },
]
