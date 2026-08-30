//@ts-check

/**
 * For a detailed explanation regarding each configuration property and type check, visit:
 * https://jestjs.io/docs/configuration
 * @type { import('jest').Config }
 */
export default {
	projects: [
		{
			displayName: 'pandora-cc-bots',
			rootDir: import.meta.dirname,

			testMatch: [
				'<rootDir>/test/**/*.test.?([mc])[jt]s?(x)',
			],
			clearMocks: true,
			errorOnDeprecated: true,
			setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
			extensionsToTreatAsEsm: ['.ts', '.tsx', '.mts'],
			transform: {
				'^.+\\.tsx?$': ['ts-jest', {
					tsconfig: '<rootDir>/test/tsconfig.json',
					useESM: true,
				}],
			},
		},
	],
	coverageProvider: 'v8',
	coverageDirectory: 'coverage_jest',
	coverageReporters: [
		'html',
		'json',
		'text-summary',
	],
	collectCoverageFrom: [
		'**/src/**/*.{ts,tsx}',
		'!**/node_modules/**',
	],
	errorOnDeprecated: true,
};
