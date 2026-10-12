import { HarnessBrowser } from '../src/browser';
import { config } from '../src/config';

const b = await HarnessBrowser.launch();
await b.open(config.frontendUrl);
console.log('Log in to Zixel in the opened browser, then close the browser window to save the session.');
await b.waitForClose();
