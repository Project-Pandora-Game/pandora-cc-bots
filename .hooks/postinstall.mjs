#!/usr/bin/env node
//@ts-check
/// <reference types="@types/node" />
/* Scripts are run in Node, so don't make use of the logger */
import { spawnSync } from 'child_process';
import { constants } from 'fs';
import { copyFile } from 'fs/promises';
import { resolve } from 'path';

postinstall();
async function postinstall() {
	const isCI = process.env.CI === 'true';
	if (!isCI) {
		setLocalGitConfig('core.hooksPath', './.hooks');
		setLocalGitConfig('core.whitespace', 'trailing-space,space-before-tab,indent-with-non-tab,incomplete-line,tabwidth=4');
	}
	try {
		await copyDotenv('.');
	} catch (e) {
		console.log(e);
	}
}

/**
 * @param {string} basePath
 */
async function copyDotenv(basePath) {
	try {
		await copyFile(
			resolve(basePath, '.env.template'),
			resolve(basePath, '.env'),
			constants.COPYFILE_EXCL,
		);
		console.log(`${basePath}: No .env file found - template copied`);
	} catch (error) {
		if (!error || typeof error !== 'object' || !(error instanceof Error) || (error.code !== 'EEXIST' && error.code !== 'ENOENT')) {
			throw error;
		}
	}
}

/**
 * Update local git config as needed
 * @param {string} config
 * @param {string} value
 */
function setLocalGitConfig(config, value) {
	const { stdout, error: getError, signal: getSignal, status: getStatus } = spawnSync('git', ['config', 'get', '--local', config], { stdio: ['pipe', 'pipe', 'inherit'] });
	const currentValue = stdout.toString().trim();

	if (getError)
		throw getError;
	if (getSignal != null)
		throw new Error(`Git config get failed with signal '${getSignal}'`);
	if (getStatus == null || ![0, 1].includes(getStatus)) // 1 is returned when not set
		throw new Error(`Git config get failed with status ${getStatus}`);

	if (currentValue === value)
		return;

	console.log(`Updating Git config "${config}": "${currentValue}" -> "${value}"`);
	const { error: setError, signal: setSignal, status: setStatus } = spawnSync('git', ['config', 'set', '--local', config, value], { stdio: ['pipe', 'inherit', 'inherit'] });
	if (setError)
		throw setError;
	if (setSignal != null)
		throw new Error(`Git config get failed with signal '${setSignal}'`);
	if (setStatus !== 0)
		throw new Error(`Git config get failed with status ${setStatus}`);
}
