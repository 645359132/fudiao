import { b } from './cycle-b';
export const a = (): unknown => b;
