// The Web Worker that reads imported files, off the page, so the app stays smooth while a
// gigabyte goes by. The conversation is in host.ts; the page's side is client.ts.

import { serve, type Port } from './host';
import { detect, importFile } from './index';

serve(self as unknown as Port, { detect, importFile });
