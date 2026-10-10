import './native-boot';
import './styles/app.css';
import { isShareHash } from './lib/share';

// A shared goal's link opens only that page (share-view.ts): no intro, no account, nothing kept on
// the device, for someone who never used Arise. Everything else opens the app.
if (isShareHash(location.hash)) import('./share-view');
else import('./app.js');
