const { spawn } = require('child_process');
const path = require('path');
const { sendMessage, sendDM } = require('./zulip-client');

function runShellPipeline(route, message) {
  return new Promise((resolve) => {
    const scriptPath = path.resolve(route.pipeline);

    const env = {
      ...process.env,
      ZULIP_MSG_ID: String(message.id),
      ZULIP_MSG_CONTENT: message.content,
      ZULIP_ADMIN_USER_ID: String(require('./config').adminUserId),
      ZULIP_MSG_SENDER: message.sender_email,
      ZULIP_MSG_SENDER_NAME: message.sender_full_name,
      ZULIP_MSG_STREAM: message.type === 'stream' ? message.display_recipient : 'dm',
      ZULIP_MSG_TOPIC: message.subject || '',
      ZULIP_MSG_TIMESTAMP: String(message.timestamp),
      ZULIP_ROUTE_NAME: route.name,
    };

    console.log(`[pipeline] Running ${route.pipeline} (route: ${route.name})`);

    const child = spawn('bash', [scriptPath], { env });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('close', async (code) => {
      if (code !== 0) {
        console.error(`[pipeline] ${route.pipeline} exited with code ${code}`);
      }
      if (stderr) {
        console.error(`[pipeline] stderr: ${stderr}`);
      }

      const output = stdout.trim();

      if (route.reply && output) {
        try {
          if (message.type === 'stream') {
            await sendMessage(message.display_recipient, message.subject, output);
            console.log(`[pipeline] Replied to ${message.display_recipient} > ${message.subject}`);
          } else {
            await sendDM(message.sender_id, output);
            console.log(`[pipeline] Replied via DM to ${message.sender_email}`);
          }
        } catch (err) {
          console.error(`[pipeline] Failed to send reply: ${err.message}`);
        }
      }

      resolve();
    });

    child.on('error', (err) => {
      console.error(`[pipeline] Failed to start ${route.pipeline}: ${err.message}`);
      resolve();
    });
  });
}

async function runPipeline(route, message) {
  if (route.type === 'sdk') {
    console.log(`[pipeline] Running SDK pipeline (route: ${route.name})`);
    const { generatePipeline } = require('./generate-pipeline');
    await generatePipeline(route, message);
  } else if (route.type === 'notes') {
    console.log(`[pipeline] Running notes pipeline (route: ${route.name})`);
    const { notesPipeline } = require('./notes-pipeline');
    await notesPipeline(route, message);
  } else if (route.type === 'interactive-dm') {
    console.log(`[pipeline] Running interactive DM pipeline (route: ${route.name})`);
    const { interactiveDmPipeline } = require('./interactive-dm-pipeline');
    await interactiveDmPipeline(route, message);
  } else {
    await runShellPipeline(route, message);
  }
}

module.exports = { runPipeline };
