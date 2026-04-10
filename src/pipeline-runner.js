async function runPipeline(route, message) {
  if (route.type === 'sdk') {
    console.log(`[pipeline] Running SDK pipeline (route: ${route.name})`);
    const { generatePipeline } = require('./generate-pipeline');
    await generatePipeline(route, message);
  } else if (route.type === 'notes') {
    console.log(`[pipeline] Running notes pipeline (route: ${route.name})`);
    const { notesPipeline } = require('./notes-pipeline');
    await notesPipeline(route, message);
  } else if (route.type === 'editor-note') {
    console.log(`[pipeline] Running editor-note pipeline (route: ${route.name})`);
    const { editorNotePipeline } = require('./note-pipeline');
    await editorNotePipeline(route, message);
  } else if (route.type === 'interactive-dm') {
    console.log(`[pipeline] Running interactive DM pipeline (route: ${route.name})`);
    const { interactiveDmPipeline } = require('./interactive-dm-pipeline');
    await interactiveDmPipeline(route, message);
  } else if (route.type === 'issue-report') {
    console.log(`[pipeline] Running issue-report pipeline (route: ${route.name})`);
    const { issueReportPipeline } = require('./issue-report-pipeline');
    await issueReportPipeline(route, message);
  }
}

module.exports = { runPipeline };
