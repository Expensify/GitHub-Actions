import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import NodeBumpConfigUtils from '../scripts/libs/NodeBumpConfigUtils';

const validConfig = {
    owner: 'Expensify',
    trackingIssueRepo: 'Expensify',
    trackingIssueLabels: ['Daily'],
    repos: [{name: 'App'}, {name: 'Web-Expensify', securityReleaseTitlePrefix: '[CP Staging & Prod]', holdForBuildBoxes: true}],
};

describe('NodeBumpConfigUtils', () => {
    it('loads config/nodeBump.json', () => {
        const config = NodeBumpConfigUtils.loadNodeBumpConfig();
        assert.equal(config.owner, 'Expensify');
        assert.ok(config.repos.some((repo) => repo.name === 'App'));
    });

    it('parses a valid config', () => {
        assert.deepEqual(NodeBumpConfigUtils.parseNodeBumpConfig(validConfig).repos.at(1), {
            name: 'Web-Expensify',
            securityReleaseTitlePrefix: '[CP Staging & Prod]',
            holdForBuildBoxes: true,
        });
    });

    it('rejects a repo listed twice', () => {
        assert.throws(() => NodeBumpConfigUtils.parseNodeBumpConfig({...validConfig, repos: [{name: 'App'}, {name: 'App'}]}), /more than once: App/);
    });

    it('rejects unknown repo keys, so a typo does not silently do nothing', () => {
        assert.throws(() => NodeBumpConfigUtils.parseNodeBumpConfig({...validConfig, repos: [{name: 'App', holdForBuildBox: true}]}), /unknown keys holdForBuildBox/);
    });

    it('rejects a repo without a name', () => {
        assert.throws(() => NodeBumpConfigUtils.parseNodeBumpConfig({...validConfig, repos: [{holdForBuildBoxes: true}]}), /needs a name/);
    });
});
