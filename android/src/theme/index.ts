import { createContext, useContext } from 'react';
import { light } from './colors';

export { light, dark } from './colors';

export { spacing } from './spacing';

export { typography } from './typography';

export const ThemeContext = createContext(light);

export const useTheme = () => useContext(ThemeContext);
