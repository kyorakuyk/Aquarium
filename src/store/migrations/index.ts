import { migration as v01 } from './v01.ts';
import { migration as v02 } from './v02.ts';
import { migration as v03 } from './v03.ts';
import { migration as v04 } from './v04.ts';
import { migration as v05 } from './v05.ts';
import { migration as v06 } from './v06.ts';
import { migration as v07 } from './v07.ts';
import { migration as v08 } from './v08.ts';
import { migration as v09 } from './v09.ts';
import { migration as v10 } from './v10.ts';
import { migration as v11 } from './v11.ts';
import { migration as v12 } from './v12.ts';
import { migration as v13 } from './v13.ts';
import { migration as v14 } from './v14.ts';
import { migration as v15 } from './v15.ts';
import { migration as v16 } from './v16.ts';
import type { Migration } from './types.ts';

export const migrations: Migration[] = [
  v01,
  v02,
  v03,
  v04,
  v05,
  v06,
  v07,
  v08,
  v09,
  v10,
  v11,
  v12,
  v13,
  v14,
  v15,
  v16,
].sort((first, second) => first.version - second.version);
