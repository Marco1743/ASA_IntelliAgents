// One-time local setup of Fast Downward (npm run setup:pddl): clone + build.
// Needs git, Python 3 (set PYTHON_CMD if not `python`), and a C++ toolchain + CMake
// (Windows: VS Build Tools "Desktop development with C++" + CMake, build from a
// Developer PowerShell; Linux/macOS: g++/clang + cmake make).

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const DIR    = join('lib', 'downward');
const ENTRY  = join(DIR, 'fast-downward.py');
const PYTHON = process.env.PYTHON_CMD || 'python';
const BRANCH = process.env.DOWNWARD_BRANCH || 'release-24.06';

const run = (cmd, opts = {}) => execSync(cmd, { stdio: 'inherit', ...opts });

try {
    if (!existsSync(ENTRY)) {
        console.log(`Cloning Fast Downward (${BRANCH}) into ${DIR} ...`);
        run(`git clone --depth 1 --branch ${BRANCH} https://github.com/aibasel/downward.git "${DIR}"`);
    } else {
        console.log('Fast Downward already cloned.');
    }

    console.log('Building Fast Downward (needs Python + a C++ toolchain + CMake) ...');
    run(`${PYTHON} build.py`, { cwd: DIR });

    console.log('\nFast Downward built. Run the BDI agent with BDI_USE_PDDL=true.');
} catch (err) {
    console.error('\nSetup failed:', err.message);
    console.error('The agent still runs on A* without it.');
    process.exit(1);
}
