import { argv } from 'node:process';

const query = argv.slice(2).join(' ');
if (!query) {
  console.error('Usage: search.mjs <query>');
  process.exit(1);
}

const SEARXNG_URL = 'http://localhost:8080/search';
const params = new URLSearchParams({
  q: query,
  format: 'json',
});

try {
  const response = await fetch(`${SEARXNG_URL}?${params}`);
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  const data = await response.json();
  
  if (!data.results || data.results.length === 0) {
    console.log('No results found.');
    process.exit(0);
  }

  data.results.slice(0, 5).forEach((result, index) => {
    console.log(`${index + 1}. ${result.title}`);
    console.log(`   URL: ${result.url}`);
    console.log(`   Snippet: ${result.content || result.snippet || 'No snippet available'}`);
    console.log('---');
  });
} catch (error) {
  console.error('Error fetching search results:', error.message);
  process.exit(1);
}
