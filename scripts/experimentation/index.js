/*
 * Copyright 2022 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import {
  getMetadata,
  sampleRUM,
  toCamelCase,
  toClassName,
} from '../lib-franklin.js';

export const DEFAULT_OPTIONS = {
  root: '/experiments',
  configFile: 'manifest.json',
  metaTag: 'experiment',
  queryParameter: 'experiment',
};

function parseAepExperimentConfig(json) {
  return {
    id: json.id,
    audiences: {},
    label: json.name,
    status: json.state,
    manifest: `https://platform-stage.adobe.io/data/core/experimentation/experiments/${json.id}`,
    variantNames: json.treatments.map((t) => t.id),
    variants: json.treatments.reduce((res, t) => {
      res[t.id] = {
        label: t.name,
        percentageSplit: t.percentage / 100,
        pages: t.assignments.filter((a) => a.parameter === 'url').map((a) => new URL(a.value).pathname),
        blocks: [],
      };
      return res;
    }, {}),
  };
}

/**
 * Parses the experimentation configuration sheet and creates an internal model.
 *
 * Output model is expected to have the following structure:
 *      {
 *        id: <string>,
 *        label: <string>,
 *        blocks: [<string>]
 *        audiences: {
 *          <string>: <string>,
 *        }
 *        status: Active | Inactive,
 *        variantNames: [<string>],
 *        variants: {
 *          [variantName]: {
 *            label: <string>
 *            percentageSplit: <number 0-1>,
 *            pages: <string>,
 *            blocks: <string>,
 *          }
 *        }
 *      };
 */
function parseExperimentConfig(json) {
  const config = {
    audiences: {},
  };
  try {
    json.settings.data.forEach((line) => {
      let key = toCamelCase(line.Name);
      if (key.startsWith('audience')) {
        key = toCamelCase(key.substring(8));
        config.audiences[key] = toCamelCase(line.Value);
        return;
      }
      if (key === 'experimentName') {
        key = 'label';
      }
      config[key] = line.Value;
    });
    const variants = {};
    let variantNames = Object.keys(json.experiences.data[0]);
    variantNames.shift();
    variantNames = variantNames.map((vn) => toCamelCase(vn));
    variantNames.forEach((variantName) => {
      variants[variantName] = {};
    });
    let lastKey = 'default';
    json.experiences.data.forEach((line) => {
      let key = toCamelCase(line.Name);
      if (!key) key = lastKey;
      lastKey = key;
      const vns = Object.keys(line);
      vns.shift();
      vns.forEach((vn) => {
        const camelVN = toCamelCase(vn);
        if (key === 'pages' || key === 'blocks') {
          variants[camelVN][key] = variants[camelVN][key] || [];
          if (key === 'pages') variants[camelVN][key].push(new URL(line[vn]).pathname);
          else variants[camelVN][key].push(line[vn]);
        } else {
          variants[camelVN][key] = line[vn];
        }
      });
    });
    config.variants = variants;
    config.variantNames = variantNames;
    return config;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('error parsing experiment config:', e, json);
  }
  return null;
}

/**
 * Gets the experiment name, if any for the page based on env, useragent, queyr params
 * @returns {string} experimentid
 */
export function getExperimentName(tagName) {
  if (navigator.userAgent.match(/bot|crawl|spider/i)) {
    return null;
  }

  return toClassName(getMetadata(tagName)) || null;
}

/**
 * Checks whether we have a valid experimentation config.
 * Mostly used to validate custom parsers.
 *
 * @param {object} config the experimentation config
 * @returns a boolean indicating whether the config is valid or not
 */
export function isValidConfig(config) {
  if (!config.variantNames
    || !config.variantNames.length
    || !config.variants
    || !Object.values(config.variants).length
    || !Object.values(config.variants).every((v) => (
      typeof v === 'object'
      && !!v.blocks
      && !!v.pages
      && (v.percentageSplit === '' || !!v.percentageSplit)
    ))) {
    console.warn('Invalid experiment config. Please review your sheet and parser.');
    return false;
  }
  return true;
}

/**
 * Gets experiment config from the manifest and transforms it to more easily
 * consumable structure.
 *
 * the manifest consists of two sheets "settings" and "experiences", by default
 *
 * "settings" is applicable to the entire test and contains information
 * like "Audience", "Status" or "Blocks".
 *
 * "experience" hosts the experiences in rows, consisting of:
 * a "Percentage Split", "Label" and a set of "Links".
 *
 *
 * @param {string} experimentId the experimentation id
 * @param {string} instantExperiment the instant experiment config
 * @returns {object} containing the experiment manifest
 */
export function getConfigForInstantExperiment(experimentId, instantExperiment) {
  const config = {
    label: `Instant Experiment: ${experimentId}`,
    audiences: {},
    status: 'Active',
    id: experimentId,
    variants: {},
    variantNames: [],
  };

  const pages = instantExperiment.split(',').map((p) => new URL(p.trim()).pathname);
  const evenSplit = 1 / (pages.length + 1);

  config.variantNames.push('control');
  config.variants.control = {
    percentageSplit: '',
    pages: [window.location.pathname],
    blocks: [],
    label: 'Control',
  };

  pages.forEach((page, i) => {
    const vname = `challenger-${i + 1}`;
    config.variantNames.push(vname);
    config.variants[vname] = {
      percentageSplit: `${evenSplit.toFixed(2)}`,
      pages: [page],
      blocks: [],
      label: `Challenger ${i + 1}`,
    };
  });

  return (config);
}

/**
 * Gets experiment config from the manifest and transforms it to more easily
 * consumable structure.
 *
 * the manifest consists of two sheets "settings" and "experiences", by default
 *
 * "settings" is applicable to the entire test and contains information
 * like "Audience", "Status" or "Blocks".
 *
 * "experience" hosts the experiences in rows, consisting of:
 * a "Percentage Split", "Label" and a set of "Links".
 *
 *
 * @param {string} experimentId the experimentation id
 * @param {object} cfg the custom experimentation config
 * @returns {object} containing the experiment manifest
 */
export async function getConfigForFullExperiment(experimentId, cfg) {
  const engine = toClassName(getMetadata('experiment-engine'));
  if (engine === 'aep') {
    const id = getMetadata('experiment');
    const bearer = window.localStorage.getItem('aep-bearer')
      || window.atob('QmVhcmVyIGV5SmhiR2NpT2lKU1V6STFOaUlzSW5nMWRTSTZJbWx0YzE5dVlURXRjM1JuTVMxclpYa3RZWFF0TVM1alpYSWlMQ0pyYVdRaU9pSnBiWE5mYm1FeExYTjBaekV0YTJWNUxXRjBMVEVpTENKcGRIUWlPaUpoZENKOS5leUpwWkNJNklqRTJPRFk1TVRRNE1EVTVNakJmWkRNM00yTTRPRE10TlRrNU1DMDBNVEZrTFdGbE5tWXRNRFkzTTJOaU5ESmtNbUpsWDNWbE1TSXNJblI1Y0dVaU9pSmhZMk5sYzNOZmRHOXJaVzRpTENKamJHbGxiblJmYVdRaU9pSmxlR05mWVhCd0lpd2lkWE5sY2w5cFpDSTZJamxHUmtJeFFUZEJOalE0T0RnMVJETXdRVFE1TkRFd05rQTJOVGcxTlRjeE16Vm1ZVEV3WWpnMk1HRTBPVFF3TVRraUxDSnpkR0YwWlNJNkludGNJbk5sYzNOcGIyNWNJanBjSW1oMGRIQnpPaTh2YVcxekxXNWhNUzF6ZEdjeExtRmtiMkpsYkc5bmFXNHVZMjl0TDJsdGN5OXpaWE56YVc5dUwzWXhMMDF0UlRSWlZGVTFXa1JyZEU5VVp6Tk9RekF3VDBSSk1VeFhTVE5OVkVGMFdWZEdhRnBVUm1sWmFsRjRXVzFSZWt4VE1ETk5lbEpFVGxSb1EwNXFWa1JTUkZFd1QxVk5lazFGUlRCUFZGRjVUVlJrUVZsNldYbGFha2t3V1RKTk1WbHFWbWxPTWxWM1dsUkNhRTVFYXpCTlJFRXdYQ0o5SWl3aVlYTWlPaUpwYlhNdGJtRXhMWE4wWnpFaUxDSmhZVjlwWkNJNklqY3pORU0xT0VJMk5VTkVORFE1UXpNd1FUUTVOREl4TjBCak5qSm1NalJqWXpWaU5XSTNaVEJsTUdFME9UUXdNRFFpTENKamRIQWlPakFzSW1abklqb2lXRkpCUVRSR1drTTJValpZUVRSRVdqZEhXazFCTWtsQlEwVTlQVDA5UFQwaUxDSnphV1FpT2lJeE5qZzJOalk0T0RRd01UYzRYemRqTmprMk9USm1MVE5tWkRFdE5HWTJOaTFpTkdRMUxUbGtPRFExTVdFMk1XSXhaRjkxWlRFaUxDSnRiMmtpT2lKak5qaGlNek0ySWl3aWNHSmhJam9pVFdWa1UyVmpUbTlGVml4TWIzZFRaV01pTENKbGVIQnBjbVZ6WDJsdUlqb2lPRFkwTURBd01EQWlMQ0pqY21WaGRHVmtYMkYwSWpvaU1UWTROamt4TkRnd05Ua3lNQ0lzSW5OamIzQmxJam9pWVdJdWJXRnVZV2RsTEdGa1pHbDBhVzl1WVd4ZmFXNW1ieXhoWkdScGRHbHZibUZzWDJsdVptOHVhbTlpWDJaMWJtTjBhVzl1TEdGa1pHbDBhVzl1WVd4ZmFXNW1ieTV3Y205cVpXTjBaV1JRY205a2RXTjBRMjl1ZEdWNGRDeGhaR1JwZEdsdmJtRnNYMmx1Wm04dWNtOXNaWE1zUVdSdlltVkpSQ3hoWkc5aVpXbHZMbUZ3Y0hKbFoybHpkSEo1TG5KbFlXUXNZV1J2WW1WcGIxOWhjR2tzWVhWa2FXVnVZMlZ0WVc1aFoyVnlYMkZ3YVN4amNtVmhkR2wyWlY5amJHOTFaQ3h0Y0hNc2IzQmxibWxrTEc5eVp5NXlaV0ZrTEhKbFlXUmZiM0puWVc1cGVtRjBhVzl1Y3l4eVpXRmtYM0JqTEhKbFlXUmZjR011WVdOd0xISmxZV1JmY0dNdVpHMWhYM1JoY25SaGJpeHpaWE56YVc5dUluMC5POGpBVGF5U2l5UWk3cUlzRS1pMjg5MzRMTzRtLV9qY3BMVVhCdWxiYTE3VmVSWHR4cEtUQ3pXRVZTWVlZcEcxMVVOT2dRTUVvSkRtdjE3SnZjeWpVWVNhM3pBUUNpMlpmeDBoLTZpVTVPYWkxc2ZqV3ZDUzhLdEk2VVlFMHRsQ0JwY3YyXy0ydHZ4YTNJcjBKZmUwOGoxcUpEYm04TUZNSDZmNTVzZWxvSVN0MGlDY3haVHdUYVBMSjdreU81UjJPUFFhbmU1cXkyTTdPNVZZQVo1MUk0cEliQndoc1Bra3FRSkNkT0lOb3ZBMUFGSGdQbzNJREJaZWZuc0RHanNPR2oxRTdQTURNeDVQWHpyUGJ1SEpob0QzdWdsbzktMUFfVGxDUktkVWNQYU8yMFdwMkVIdHZTNjBmalMwa2pveDZXTm5hbEpNVFA0bm5EZU9Ga1FYTkE=');
    if (!bearer) {
      console.error('Missing bearer token, Please set "window.localStorage.setItem(\'aep-bearer\', \'Bearer …\')" to fetch the experimentation config.');
      return null;
    }
    const response = await fetch(`https://platform-stage.adobe.io/data/core/experimentation/experiments/${id}`, {
      headers: {
        accept: 'application/vnd.adobe.experimentation.v1+json',
        authorization: bearer,
        'x-api-key': 'exc_app',
        'x-gw-ims-org-id': '745F37C35E4B776E0A49421B@AdobeOrg',
        'x-sandbox-name': 'prod',
      },
    });
    const config = await response.json();
    return parseAepExperimentConfig(config);
  }
  const path = `${cfg.root}/${experimentId}/${cfg.configFile}`;
  try {
    const resp = await fetch(path);
    if (!resp.ok) {
      console.log('error loading experiment config:', resp);
      return null;
    }
    const json = await resp.json();
    const config = cfg.parser
      ? cfg.parser(json)
      : parseExperimentConfig(json);
    if (!config) {
      return null;
    }
    config.id = experimentId;
    config.manifest = path;
    config.basePath = `${cfg.root}/${experimentId}`;
    return config;
  } catch (e) {
    console.log(`error loading experiment manifest: ${path}`, e);
  }
  return null;
}

/**
 * Gets the UED compatible decision policy for the specified experimentation config
 * @param {object} config the experimentation config
 * @returns the decision policy to run through the UED engine
 */
function getDecisionPolicy(config) {
  const decisionPolicy = {
    id: 'content-experimentation-policy',
    rootDecisionNodeId: 'n1',
    decisionNodes: [{
      id: 'n1',
      type: 'EXPERIMENTATION',
      experiment: {
        id: config.id,
        identityNamespace: 'ECID',
        randomizationUnit: 'DEVICE',
        treatments: Object.entries(config.variants).map(([key, props]) => ({
          id: key,
          allocationPercentage: props.percentageSplit
            ? parseFloat(props.percentageSplit) * 100
            : 100 - Object.values(config.variants).reduce((result, variant) => {
              // eslint-disable-next-line no-param-reassign
              result -= parseFloat(variant.percentageSplit || 0) * 100;
              return result;
            }, 100),
        })),
      },
    }],
  };
  return decisionPolicy;
}

/**
 * this is an extensible stub to take on audience mappings
 * @param {object} audiences the experiment audiences
 * @param {object} selected the experiment config
 * @return {boolean} is member of this audience
 */
async function isValidAudience(audiences, selected) {
  const results = await Promise.all(Object.entries(selected).map(([key, value]) => {
    if (audiences[key] && typeof audiences[key] === 'function') {
      return audiences[key](value);
    }
    if (audiences[key] && audiences[key][value] && typeof audiences[key][value] === 'function') {
      return audiences[key][value]();
    }
    return true;
  }));
  return results.every((res) => res);
}

/**
 * Replaces element with content from path
 * @param {string} path
 * @param {HTMLElement} element
 * @param {boolean} isBlock
 */
async function replaceInner(path, element) {
  const plainPath = `${path}.plain.html`;
  try {
    const resp = await fetch(plainPath);
    if (!resp.ok) {
      console.log('error loading experiment content:', resp);
      return false;
    }
    const html = await resp.text();
    // eslint-disable-next-line no-param-reassign
    element.innerHTML = html;
    return true;
  } catch (e) {
    console.log(`error loading experiment content: ${plainPath}`, e);
  }
  return false;
}

/**
 * Gets the experimentation config for the specified experiment
 * @param {string} experiment the experiment id
 * @param {string} [instantExperiment] the instant experiment config
 * @param {object} [config] the custom config for the experimentation plugin
 * @returns the experiment configuration
 */
export async function getConfig(experiment, instantExperiment = null, config = DEFAULT_OPTIONS) {
  const usp = new URLSearchParams(window.location.search);
  const [forcedExperiment, forcedVariant] = usp.has(config.queryParameter) ? usp.get(config.queryParameter).split('/') : [];

  const experimentConfig = instantExperiment
    ? await getConfigForInstantExperiment(experiment, instantExperiment)
    : await getConfigForFullExperiment(experiment, config);
  console.debug(experimentConfig);
  if (!experimentConfig || (toCamelCase(experimentConfig.status) !== 'active' && !forcedExperiment)) {
    return null;
  }

  experimentConfig.run = !!forcedExperiment
    || await isValidAudience(config.audiences, experimentConfig.audiences);
  window.hlx = window.hlx || {};
  window.hlx.experiment = experimentConfig;
  console.debug('run', experimentConfig.run, experimentConfig.audiences);
  if (!experimentConfig.run) {
    return null;
  }

  if (forcedVariant && experimentConfig.variantNames.includes(forcedVariant)) {
    experimentConfig.selectedVariant = forcedVariant;
  } else {
    // eslint-disable-next-line import/extensions
    const { ued } = await import('./ued.js');
    const decision = ued.evaluateDecisionPolicy(getDecisionPolicy(experimentConfig), {});
    experimentConfig.selectedVariant = decision.items[0].id;
  }
  return experimentConfig;
}

/**
 * Runs the configured experiments on the current page.
 * @param {string} experiment the experiment id
 * @param {string} instantExperiment the instant experiment config
 * @param {object} customOptions the custom config for the experimentation plugin
 * @returns a boolean indicating whether the experiment was run successfully or not
 */
export async function runExperiment(experiment, instantExperiment, customOptions) {
  const options = {
    ...DEFAULT_OPTIONS,
    ...customOptions,
  };
  const experimentConfig = await getConfig(experiment, instantExperiment, options);
  if (!experimentConfig || !isValidConfig(experimentConfig)) {
    return false;
  }

  console.debug(`running experiment (${window.hlx.experiment.id}) -> ${window.hlx.experiment.selectedVariant}`);

  if (experimentConfig.selectedVariant === experimentConfig.variantNames[0]) {
    return false;
  }

  const { pages } = experimentConfig.variants[experimentConfig.selectedVariant];
  if (!pages.length) {
    return false;
  }

  const currentPath = window.location.pathname;
  const control = experimentConfig.variants[experimentConfig.variantNames[0]];
  const index = control.pages.indexOf(currentPath);
  if (index < 0 || pages[index] === currentPath) {
    return false;
  }

  // Fullpage content experiment
  document.body.classList.add(`experiment-${experimentConfig.id}`);
  const result = await replaceInner(pages[0], document.querySelector('main'));
  if (!result) {
    console.debug(`failed to serve variant ${window.hlx.experiment.selectedVariant}. Falling back to ${experimentConfig.variantNames[0]}.`);
  }
  document.body.classList.add(`variant-${result ? experimentConfig.selectedVariant : experimentConfig.variantNames[0]}`);
  sampleRUM('experiment', {
    source: experimentConfig.id,
    target: result ? experimentConfig.selectedVariant : experimentConfig.variantNames[0],
  });
  return result;
}

/**
 * Patches the block config for the experimentation use case.
 * @param {object} config the block config
 * @returns the patched block config for experimentation
 */
export function patchBlockConfig(config) {
  const { experiment } = window.hlx;

  // No experiment is running
  if (!experiment || !experiment.run) {
    return config;
  }

  // The current experiment does not modify the block
  if (experiment.selectedVariant === experiment.variantNames[0]
    || !experiment.blocks || !experiment.blocks.includes(config.blockName)) {
    return config;
  }

  // The current experiment does not modify the block code
  const variant = experiment.variants[experiment.selectedVariant];
  if (!variant.blocks.length) {
    return config;
  }

  let index = experiment.variants[experiment.variantNames[0]].blocks.indexOf('');
  if (index < 0) {
    index = experiment.variants[experiment.variantNames[0]].blocks.indexOf(config.blockName);
  }
  if (index < 0) {
    index = experiment.variants[experiment.variantNames[0]].blocks.indexOf(`/blocks/${config.blockName}`);
  }
  if (index < 0) {
    return config;
  }

  let origin = '';
  let path;
  if (/^https?:\/\//.test(variant.blocks[index])) {
    const url = new URL(variant.blocks[index]);
    // Experimenting from a different branch
    if (url.origin !== window.location.origin) {
      origin = url.origin;
    }
    // Experimenting from a block path
    if (url.pathname !== '/') {
      path = url.pathname;
    } else {
      path = `/blocks/${config.blockName}`;
    }
  } else { // Experimenting from a different branch on the same branch
    path = variant.blocks[index];
  }
  if (!origin && !path) {
    return config;
  }

  const { codeBasePath } = window.hlx;
  return {
    ...config,
    cssPath: `${origin}${codeBasePath}${path}/${config.blockName}.css`,
    jsPath: `${origin}${codeBasePath}${path}/${config.blockName}.js`,
  };
}
window.hlx.patchBlockConfig.push(patchBlockConfig);
