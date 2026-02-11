const config = require('../config.json');
const { runPipeline } = require('./pipeline-runner');

function matchRoute(content) {
  for (const route of config.routes) {
    const pattern = route.match;

    // Support /regex/ patterns
    const regexMatch = pattern.match(/^\/(.+)\/([gimsuy]*)$/);
    if (regexMatch) {
      const regex = new RegExp(regexMatch[1], regexMatch[2] || 'i');
      if (regex.test(content)) return route;
    } else {
      // Substring match (case-insensitive)
      if (content.toLowerCase().includes(pattern.toLowerCase())) return route;
    }
  }

  return null;
}

async function routeMessage(message) {
  const route = matchRoute(message.content);

  if (route) {
    console.log(`[router] Matched route "${route.name}" for message ${message.id}`);
    await runPipeline(route, message);
  } else if (config.defaultPipeline) {
    console.log(`[router] No match — running default pipeline for message ${message.id}`);
    await runPipeline({ name: 'default', pipeline: config.defaultPipeline, reply: false }, message);
  } else {
    console.log(`[router] No match for message ${message.id}, skipping`);
  }
}

module.exports = { routeMessage };
