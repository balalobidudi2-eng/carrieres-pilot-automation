const https = require('https');

const TOKEN = '8acd7436-68f4-416b-8f96-f466398ddf41';
const PROJECT_ID = 'e0c9fde1-260c-44dd-b155-f56e43365950';
const ENV_ID = '427a002a-3c3f-48eb-bf7d-eb19474b7311';
const SERVICE_ID = 'e8a9b484-a680-4e18-9dab-c2633c7ed98a';
const LATEST_FAILED_DEP = 'c90cca95-3658-4899-aba6-5cde037b4c4d';

function gql(query) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query });
    const opts = {
      hostname: 'backboard.railway.app',
      path: '/graphql/v2',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}`, 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(opts, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(JSON.parse(b))); });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

const NEW_SERVICE_ID = '9332df85-c4d7-42cd-bbb8-95ade0e6efc9';
const NEW_DOMAIN = 'automation-v2-production.up.railway.app';

async function main() {
  // Get latest deployment ID for new service
  const deps = await gql(`
    query {
      deployments(input: { serviceId: "${NEW_SERVICE_ID}", environmentId: "${ENV_ID}" }) {
        edges { node { id status createdAt } }
      }
    }
  `);
  const edges = deps.data?.deployments?.edges || [];
  edges.slice(0,3).forEach(e => console.log('Deployment:', e.node.id, e.node.status, e.node.createdAt));
  const latestDep = edges[0]?.node;
  if (!latestDep) { console.log('No deployments found'); return; }

  // Get build logs
  const buildLogs = await gql(`
    query {
      buildLogs(deploymentId: "${latestDep.id}") {
        message timestamp
      }
    }
  `);
  if (buildLogs.errors) { console.log('BUILD LOG ERRORS:', JSON.stringify(buildLogs.errors)); }
  const blines = buildLogs.data?.buildLogs || [];
  console.log('\nBUILD LOGS (last 40):');
  blines.slice(-40).forEach(l => console.log(l.message));
}

main().catch(console.error);






