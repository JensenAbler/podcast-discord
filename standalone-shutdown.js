// Leave five seconds before the managed service's 30-second stop timeout.
const SHUTDOWN_TIMEOUT_MS = 25_000;

/**
 * Own process shutdown only for the standalone bot. Injected process/timers let
 * tests exercise signals and deadlines without Discord or wall-clock sleeps.
 */
function startStandaloneBot(bot, {
    processRef = process,
    log = (message, level = 'INFO') => {
        if (level === 'ERROR' || level === 'FATAL') console.error(message);
        else console.log(message);
    },
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout
} = {}) {
    let shuttingDown = false;
    let finished = false;
    let deadline;

    const finish = (code) => {
        if (finished) return;
        finished = true;
        clearTimeoutFn(deadline);
        // Cleanup has settled, or its deadline has elapsed. Remaining handles
        // must not keep the standalone process alive past the service timeout.
        processRef.exit(code);
    };

    const shutdown = async (signal) => {
        if (shuttingDown || finished) return;
        shuttingDown = true;
        // Keep this timer referenced: an unresolved Promise alone cannot keep
        // Node alive long enough to report a hung cleanup.
        deadline = setTimeoutFn(() => {
            log(`[Shutdown] ${signal}: cleanup timed out after ${SHUTDOWN_TIMEOUT_MS}ms; exiting with code 1`, 'ERROR');
            finish(1);
        }, SHUTDOWN_TIMEOUT_MS);
        log(`[Shutdown] ${signal} received; awaiting bot cleanup`);

        try {
            await bot.stop();
        } catch (error) {
            if (!finished) {
                log(`[Shutdown] ${signal}: cleanup failed; exiting with code 1: ${error?.stack || error}`, 'ERROR');
                finish(1);
            }
            return;
        }

        if (!finished) {
            const code = processRef.exitCode || 0;
            log(`[Shutdown] ${signal}: cleanup complete; exiting with code ${code}`);
            finish(code);
        }
    };

    // Keep both listeners installed during cleanup so repeated/mixed signals
    // cannot invoke cleanup twice or restore the default immediate termination.
    processRef.on('SIGTERM', () => { void shutdown('SIGTERM'); });
    processRef.on('SIGINT', () => { void shutdown('SIGINT'); });

    return bot.start().catch((error) => {
        if (finished) return;
        log(`Bot failed to start: ${error?.stack || error}`, 'FATAL');
        processRef.exitCode = 1;
        // A startup rejection must not cut short cleanup already in progress.
        if (!shuttingDown) finish(1);
    });
}

module.exports = { startStandaloneBot, SHUTDOWN_TIMEOUT_MS };
