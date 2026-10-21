import { Space_Grotesk, JetBrains_Mono } from 'next/font/google';
import './globals.css';

const sans = Space_Grotesk({ subsets: ['latin'], variable: '--font-sans' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono' });

const TITLE = 'ShareBin: share code and files for a few minutes';
const DESCRIPTION = 'No sign-up. Paste code, text or a file, get a 5-character code, and it disappears after 1 to 10 minutes.';

export const metadata = {
  title: TITLE,
  description: DESCRIPTION,
  applicationName: 'ShareBin',
  manifest: '/site.webmanifest',
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
      { url: '/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
    ],
    shortcut: '/favicon.ico',
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
  appleWebApp: { title: 'ShareBin', capable: true, statusBarStyle: 'black-translucent' },
  openGraph: { siteName: 'ShareBin', title: TITLE, description: DESCRIPTION, type: 'website' },
};
export const viewport = { width: 'device-width', initialScale: 1, themeColor: '#0a1f4d' };

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`dark ${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
