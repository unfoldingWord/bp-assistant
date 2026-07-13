// Pipelines that write under CSKILLBP_DIR/output and CSKILLBP_DIR/tmp. Sweep
// foreign-owned leftovers before they cause mid-run EACCES failures.
const WORKSPACE_WRITING_ROUTES = new Set(['sdk', 'notes', 'tqs', 'translate']);

async function runPipeline(route, message) {
  if (WORKSPACE_WRITING_ROUTES.has(route.type)) {
    try {
      const { sweepWorkspaceOwnership, sweepStaleTmp } = require('./ownership-sweep');
      sweepWorkspaceOwnership();
      sweepStaleTmp();
    } catch (err) {
      console.warn(`[ownership-sweep] skipped: ${err.message}`);
    }
  }
  if (route.type === 'sdk') {
    console.log(`[pipeline] Running SDK pipeline (route: ${route.name})`);
    const { generatePipeline } = require('./generate-pipeline');
    await generatePipeline(route, message);
  } else if (route.type === 'notes') {
    console.log(`[pipeline] Running notes pipeline (route: ${route.name})`);
    const { notesPipeline } = require('./notes-pipeline');
    await notesPipeline(route, message);
  } else if (route.type === 'tqs') {
    console.log(`[pipeline] Running TQ pipeline (route: ${route.name})`);
    const { tqsPipeline } = require('./tqs-pipeline');
    await tqsPipeline(route, message);
  } else if (route.type === 'translate') {
    console.log(`[pipeline] Running translate pipeline (route: ${route.name})`);
    const { translatePipeline } = require('./translate-pipeline');
    await translatePipeline(route, message);
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
  } else if (route.type === 'api') {
    console.log(`[pipeline] Running API pipeline (route: ${route.name})`);
    const { apiPipeline } = require('./api-runner/api-pipeline');
    await apiPipeline(route, message);
  }
}

module.exports = { runPipeline };
