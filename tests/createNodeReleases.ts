import type {NodeRelease} from '../scripts/libs/NodeReleaseUtils';
import NodeReleaseUtils from '../scripts/libs/NodeReleaseUtils';

/**
 * A slice of https://nodejs.org/dist/index.json with a security release on both the 26.x and 24.x lines.
 */
function createNodeReleases(): NodeRelease[] {
    return NodeReleaseUtils.parseNodeReleases([
        {version: 'v26.13.1', npm: '11.21.0', security: true, date: '2026-11-11'},
        {version: 'v26.13.0', npm: '11.20.0', security: false, date: '2026-10-28'},
        {version: 'v26.12.1', npm: '11.20.0', security: true, date: '2026-10-21'},
        {version: 'v26.12.0', npm: '11.20.0', security: false, date: '2026-10-14'},
        {version: 'v24.22.3', npm: '11.19.1', security: true, date: '2026-11-11'},
        {version: 'v24.22.2', npm: '11.19.1', security: false, date: '2026-10-27'},
        {version: 'v24.22.1', npm: '11.19.1', security: true, date: '2026-10-20'},
    ]);
}

export default createNodeReleases;
