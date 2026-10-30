import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { words } from '../words';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: words.appName,
  robots: { index: false, follow: false }
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
