import { redirect } from 'next/navigation';

// The dashboard lives at /market/[symbol]; the root address forwards to the
// default market instead of rendering a second copy of the page.
export default function Home() {
    redirect('/market/BTCUSDT');
}
