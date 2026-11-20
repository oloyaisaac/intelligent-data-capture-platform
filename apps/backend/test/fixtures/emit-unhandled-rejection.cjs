// Test-only preload: synthesize a rejection once the real entry point registers its handler.
process.on('newListener', (event) => {
  if (event === 'unhandledRejection') {
    globalThis.setImmediate(() => {
      process.emit(
        'unhandledRejection',
        new Error('SYNTHETIC-REJECTION-SECRET'),
        Promise.resolve(),
      );
    });
  }
});
