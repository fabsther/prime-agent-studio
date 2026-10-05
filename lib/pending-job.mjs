export function createPendingJobs() {
  const pending = new Map();
  return async (key, launch) => {
    if (pending.has(key)) return pending.get(key);
    const job = launch();
    pending.set(key, job);
    try {
      return await job;
    } finally {
      if (pending.get(key) === job) pending.delete(key);
    }
  };
}
