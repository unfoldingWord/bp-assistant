// resource-monitor.js — Periodic peak memory/CPU sampler
//
// Samples process.memoryUsage() and process.cpuUsage() every 60 seconds,
// tracking peaks within each hour. Appends one `type: "resource_peak"` entry
// to usage.jsonl per hour so resource trends can be queried later:
//
//   grep resource_peak data/metrics/usage.jsonl | jq -s 'max_by(.rss_peak_mb)'

const fs = require('fs');

const SAMPLE_INTERVAL_MS = 60 * 1000;   // poll every 60s
const FLUSH_INTERVAL_MS  = 60 * 60 * 1000; // write entry every hour

function startResourceMonitor(metricsFile) {
  let periodStart = new Date().toISOString();
  let cpuBaseline = process.cpuUsage();
  let rssPeakMb = 0;
  let heapPeakMb = 0;

  // Sample loop — update peaks
  const sampleTimer = setInterval(() => {
    const mem = process.memoryUsage();
    const rssMb = mem.rss / 1024 / 1024;
    const heapMb = mem.heapUsed / 1024 / 1024;
    if (rssMb  > rssPeakMb)  rssPeakMb  = rssMb;
    if (heapMb > heapPeakMb) heapPeakMb = heapMb;
  }, SAMPLE_INTERVAL_MS);

  // Flush loop — write entry and reset
  const flushTimer = setInterval(() => {
    const cpu = process.cpuUsage(cpuBaseline);
    const entry = {
      ts: new Date().toISOString(),
      type: 'resource_peak',
      period_start: periodStart,
      rss_peak_mb:      Math.round(rssPeakMb  * 10) / 10,
      heap_used_peak_mb: Math.round(heapPeakMb * 10) / 10,
      cpu_user_s:   Math.round(cpu.user   / 1e4) / 100,
      cpu_system_s: Math.round(cpu.system / 1e4) / 100,
    };
    try {
      fs.appendFileSync(metricsFile, JSON.stringify(entry) + '\n');
      console.log(`[resource-monitor] rss_peak=${entry.rss_peak_mb}MB heap_peak=${entry.heap_used_peak_mb}MB cpu_user=${entry.cpu_user_s}s`);
    } catch (err) {
      console.error(`[resource-monitor] Failed to write entry: ${err.message}`);
    }
    // Reset for next period
    periodStart = new Date().toISOString();
    cpuBaseline = process.cpuUsage();
    rssPeakMb  = 0;
    heapPeakMb = 0;
  }, FLUSH_INTERVAL_MS);

  // Don't prevent process exit
  sampleTimer.unref();
  flushTimer.unref();
}

module.exports = { startResourceMonitor };
