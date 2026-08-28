// Pipelines that write under CSKILLBP_DIR/{output,tmp,door43-repos}. Sweep
// foreign-owned leftovers before they cause mid-run EACCES failures. The
// door43-repos tree is included because door43-push.js writes directly into
// door43-repos/<repo>/.git/objects/** on every push; a prior privileged/root
// launch (or a container restart mid-write) can leave objects or shard dirs
// owned by root, and the next unprivileged push into the same shard directory
// fails with EACCES on open() (see issue #207).
const WORKSPACE_WRITING_ROUTES = new Set(['sdk', 'notes', 'tqs', 'translate']);
const SWEEP_SUBDIRS = ['output', 'tmp', 'door43-repos'];

// Surface unfixable foreign ownership on the admin dashboard, and abort before
// the run starts when the blocked paths are in a door43 git tree — otherwise the
// pipeline discovers them ~55 minutes later at door43-push (issue #349).
async function guardWorkspaceOwnership(route) {
  const { sweepWorkspaceOwnership, sweepStaleTmp, partitionBlocked } = require('./ownership-sweep');
  const result = sweepWorkspaceOwnership({ subdirs: SWEEP_SUBDIRS });
  sweepStaleTmp();
  if (!result || !result.blocked.length) return;

  const { publishAdminStatus } = require('./admin-status');
  const { fatal, advisory } = partitionBlocked(result.blocked);
  const owner = `uid ${result.targetUid}:${result.targetGid}`;
  const preview = (list) => list.slice(0, 5).join(', ') + (list.length > 5 ? `, +${list.length - 5} more` : '');

  // Fatal before advisory: an advisory publishAdminStatus failure must not
  // reach runPipeline's catch and let a blocked door43 git tree proceed.
  if (fatal.length) {
    const detail =
      `ownership-sweep: ${fatal.length} path(s) under door43-repos/*/.git are foreign-owned and unwritable by ` +
      `${owner} — every push writes loose objects there, so this run would fail at door43-push. ` +
      `Aborting before work starts. Fix with a privileged chown -R, then re-run: ${preview(fatal)}`;
    const err = new Error(detail);
    err.errorKind = 'workspace_ownership_blocked';
    try {
      await publishAdminStatus({
        pipelineType: route.type,
        phase: 'preflight',
        severity: 'error',
        message: detail,
      });
    } catch (publishErr) {
      console.warn(`[ownership-sweep] failed to publish fatal admin status: ${publishErr.message}`);
    }
    throw err;
  }

  if (advisory.length) {
    try {
      await publishAdminStatus({
        pipelineType: route.type,
        phase: 'preflight',
        severity: 'warn',
        message:
          `ownership-sweep: ${advisory.length} workspace path(s) are foreign-owned and unwritable by ${owner} ` +
          `— running unprivileged, could not chown. These may cause EACCES: ${preview(advisory)}`,
      });
    } catch (publishErr) {
      console.warn(`[ownership-sweep] failed to publish advisory admin status: ${publishErr.message}`);
    }
  }
}

async function runPipeline(route, message) {
  if (WORKSPACE_WRITING_ROUTES.has(route.type)) {
    try {
      await guardWorkspaceOwnership(route);
    } catch (err) {
      // A blocked door43 git tree is fatal; anything else in the sweep is
      // best-effort and must not take the pipeline down.
      if (err && err.errorKind === 'workspace_ownership_blocked') throw err;
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
