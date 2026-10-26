/** Jest projects for the IDCP monorepo. Run with: npm test */

const sharedMapper = {
  '^@idcp/shared/ids$': '<rootDir>/../../packages/shared/src/ids.ts',
  '^@idcp/shared$': '<rootDir>/../../packages/shared/src/index.ts',
};

module.exports = {
  // Global defaults inherited by every project.
  testTimeout: 30000,

  projects: [
    {
      displayName: 'shared',
      testEnvironment: 'node',
      rootDir: 'packages/shared',
      testMatch: ['<rootDir>/test/**/*.test.ts'],
      moduleNameMapper: sharedMapper,
      transform: {
        '^.+\\.ts$': [
          'ts-jest',
          { tsconfig: '<rootDir>/../../tsconfig.base.json', isolatedModules: true },
        ],
      },
    },
    {
      displayName: 'connectors',
      testEnvironment: 'node',
      rootDir: 'packages/connectors',
      testMatch: ['<rootDir>/test/**/*.test.ts'],
      moduleNameMapper: sharedMapper,
      transform: {
        '^.+\\.ts$': [
          'ts-jest',
          { tsconfig: '<rootDir>/../../tsconfig.base.json', isolatedModules: true },
        ],
      },
    },
    {
      displayName: 'backend',
      testEnvironment: 'node',
      rootDir: 'apps/backend',
      testMatch: ['<rootDir>/test/**/*.test.ts'],
      moduleNameMapper: {
        ...sharedMapper,
        '^@idcp/connectors$': '<rootDir>/../../packages/connectors/src/index.ts',
      },
      transform: {
        '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json', isolatedModules: true }],
      },
    },
    {
      displayName: 'desktop',
      testEnvironment: 'jsdom',
      rootDir: 'apps/desktop',
      testMatch: ['<rootDir>/test/**/*.test.ts?(x)'],
      moduleNameMapper: {
        ...sharedMapper,
        // Static assets are irrelevant to behaviour; stub them so imports resolve.
        '\\.(css|svg|png|jpg)$': '<rootDir>/test/stubs/file.ts',
      },
      transform: {
        '^.+\\.tsx?$': [
          'ts-jest',
          { tsconfig: '<rootDir>/tsconfig.test.json', isolatedModules: true },
        ],
      },
    },
    {
      displayName: 'mobile',
      testEnvironment: 'node',
      rootDir: 'apps/mobile',
      testMatch: ['<rootDir>/test/**/*.test.ts'],
      moduleNameMapper: sharedMapper,
      transform: {
        '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json', isolatedModules: true }],
      },
    },
  ],
};
