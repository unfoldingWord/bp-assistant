// orchestrations/index.js — Registry of pipeline orchestrations

const orchestrations = {
  'initial-pipeline': require('./initial-pipeline'),
  'deep-issue-id': require('./deep-issue-id'),
  'parallel-batch': require('./parallel-batch'),
  'align-all-parallel': require('./align-all-parallel'),
  'makeBP': require('./makeBP'),
};

module.exports = { orchestrations };
