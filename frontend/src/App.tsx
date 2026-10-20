import { useCallback, useEffect, useMemo, useState } from 'react';

type Product = {
  id: number;
  'Product Name': string;
  Price: number | string;
  Category: string | null;
  Quantity: number;
  Seller: string | null;
  image_url: string | null;
};

const API_BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/+$/, '');

function isProduct(value: unknown): value is Product {
  if (typeof value !== 'object' || value === null) return false;

  const product = value as Record<string, unknown>;
  return (
    typeof product.id === 'number' &&
    typeof product['Product Name'] === 'string' &&
    (typeof product.Price === 'number' || typeof product.Price === 'string') &&
    (typeof product.Category === 'string' || product.Category === null) &&
    typeof product.Quantity === 'number' &&
    (typeof product.Seller === 'string' || product.Seller === null) &&
    (typeof product.image_url === 'string' || product.image_url === null)
  );
}

function apiMessage(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('message' in value)) {
    return undefined;
  }

  return typeof value.message === 'string' ? value.message : undefined;
}

function formatPrice(price: Product['Price']): string {
  const amount = Number(price);
  return Number.isFinite(amount)
    ? new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(amount)
    : 'Price unavailable';
}

export default function App() {
  const [products, setProducts] = useState<Product[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadProducts = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`${API_BASE}/api/products`, {
        headers: { Accept: 'application/json' },
        credentials: 'include',
      });
      const payload: unknown = await response.json();

      if (!response.ok) {
        throw new Error(apiMessage(payload) ?? 'The marketplace could not be loaded.');
      }
      if (!Array.isArray(payload) || !payload.every(isProduct)) {
        throw new Error('The marketplace returned an unexpected response.');
      }

      setProducts(payload);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'A network error prevented the marketplace from loading.',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProducts();
  }, [loadProducts]);

  const visibleProducts = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    if (!term) return products;

    return products.filter((product) =>
      [product['Product Name'], product.Category ?? '', product.Seller ?? '']
        .join(' ')
        .toLocaleLowerCase()
        .includes(term),
    );
  }, [products, search]);

  return (
    <div className="store-shell" id="top">
      <header className="site-header">
        <a className="brand" href="#top" aria-label="BlueMart home">
          <span className="brand-mark" aria-hidden="true">B</span>
          <span>BlueMart</span>
        </a>
        <nav className="site-nav" aria-label="Main navigation">
          <a href="#products">Shop</a>
          <a href="/privacy">Privacy</a>
        </nav>
      </header>

      <main>
        <section className="hero" aria-labelledby="page-title">
          <p className="eyebrow">A marketplace made for discovery</p>
          <h1 id="page-title">Find something <span>good.</span></h1>
          <p className="hero-copy">
            Browse independent sellers and one-of-a-kind finds, all in one place.
          </p>
          <a className="primary-link" href="#products">Explore products <span aria-hidden="true">↓</span></a>
        </section>

        <section className="catalog" id="products" aria-labelledby="catalog-title">
          <div className="catalog-heading">
            <div>
              <p className="eyebrow">The marketplace</p>
              <h2 id="catalog-title">Discover products</h2>
            </div>
            <label className="search-box">
              <span className="visually-hidden">Search products, categories, or sellers</span>
              <span aria-hidden="true">⌕</span>
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search the marketplace"
              />
            </label>
          </div>

          {error && (
            <div className="notice notice-error" role="alert">
              <p>{error}</p>
              <button type="button" onClick={() => void loadProducts()}>Try again</button>
            </div>
          )}

          {loading ? (
            <p className="catalog-status" role="status">Loading products…</p>
          ) : !error && visibleProducts.length === 0 ? (
            <div className="catalog-empty">
              <span aria-hidden="true">✳</span>
              <h3>{search ? 'No matches found' : 'Your next find is on its way'}</h3>
              <p>{search ? 'Try a different search.' : 'There are no products to show right now.'}</p>
            </div>
          ) : (
            <div className="product-grid">
              {visibleProducts.map((product) => (
                <article className="product-card" key={product.id}>
                  <div className="product-image">
                    {product.image_url ? (
                      <img src={product.image_url} alt={product['Product Name']} loading="lazy" />
                    ) : (
                      <span aria-hidden="true">B</span>
                    )}
                    <span className={`stock-badge${product.Quantity > 0 ? '' : ' stock-empty'}`}>
                      {product.Quantity > 0 ? 'In stock' : 'Sold out'}
                    </span>
                  </div>
                  <div className="product-details">
                    <div className="product-meta">
                      <span>{product.Category || 'Everything else'}</span>
                      {product.Seller && <span>by {product.Seller}</span>}
                    </div>
                    <h3>{product['Product Name']}</h3>
                    <p className="product-price">{formatPrice(product.Price)}</p>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </main>

      <footer className="site-footer">
        <a className="brand" href="#top">
          <span className="brand-mark" aria-hidden="true">B</span>
          <span>BlueMart</span>
        </a>
        <p>Discover more. Shop thoughtfully.</p>
        <nav aria-label="Legal">
          <a href="/privacy">Privacy</a>
          <a href="/terms">Terms</a>
          <a href="/refunds">Refunds</a>
          <a href="/cookies">Cookies</a>
        </nav>
      </footer>
    </div>
  );
}
