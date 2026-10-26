/**
 * React Native entry point. Registers the root component only — all behaviour lives in src/.
 */
import { AppRegistry } from 'react-native';
import { App } from './src/App';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);
