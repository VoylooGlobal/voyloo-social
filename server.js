require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const {
  INSTAGRAM_APP_ID,
  INSTAGRAM_APP_SECRET,
  ANTHROPIC_API_KEY,
  PORT = 3000
} = process.env;

const REDIRECT_URI = 'https://voyloo.com/auth/instagram/callback';

// ─── STEP 1: Redirect user to Instagram OAuth login ───────────────────────────
app.get('/auth/instagram', (req, res) => {
  const scope = [
    'instagram_basic',
    'instagram_content_publish',
    'pages_read_engagement',
    'pages_show_list'
  ].join(',');

  const url =
    `https://www.facebook.com/v19.0/dialog/oauth` +
    `?client_id=${INSTAGRAM_APP_ID}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&scope=${scope}` +
    `&response_type=code`;

  res.redirect(url);
});

// ─── STEP 2: Handle OAuth callback — exchange code for long-lived token ───────
app.get('/auth/instagram/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error || !code) {
    return res.redirect('/?error=auth_failed');
  }

  try {
    // Exchange code for short-lived token
    const tokenRes = await axios.get('https://graph.facebook.com/v19.0/oauth/access_token', {
      params: {
        client_id: INSTAGRAM_APP_ID,
        client_secret: INSTAGRAM_APP_SECRET,
        redirect_uri: REDIRECT_URI,
        code
      }
    });

    const shortLivedToken = tokenRes.data.access_token;

    // Exchange for long-lived token (60 days)
    const longLivedRes = await axios.get('https://graph.facebook.com/v19.0/oauth/access_token', {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: INSTAGRAM_APP_ID,
        client_secret: INSTAGRAM_APP_SECRET,
        fb_exchange_token: shortLivedToken
      }
    });

    const longLivedToken = longLivedRes.data.access_token;
    const expiresIn = longLivedRes.data.expires_in;

    // Get Facebook Pages to find linked Instagram Business Account
    const pagesRes = await axios.get('https://graph.facebook.com/v19.0/me/accounts', {
      params: { access_token: longLivedToken }
    });

    const pages = pagesRes.data.data;
    if (!pages || pages.length === 0) {
      return res.redirect('/?error=no_pages');
    }

    // Get Instagram Business Account ID from the first page
    const page = pages[0];
    const igRes = await axios.get(`https://graph.facebook.com/v19.0/${page.id}`, {
      params: {
        fields: 'instagram_business_account',
        access_token: page.access_token
      }
    });

    const igAccountId = igRes.data?.instagram_business_account?.id;
    if (!igAccountId) {
      return res.redirect('/?error=no_ig_account');
    }

    // Redirect back to frontend with tokens in URL params (frontend stores in sessionStorage)
    res.redirect(
      `/?token=${longLivedToken}` +
      `&ig_id=${igAccountId}` +
      `&page_token=${page.access_token}` +
      `&expires_in=${expiresIn}`
    );

  } catch (err) {
    console.error('OAuth error:', err.response?.data || err.message);
    res.redirect('/?error=token_exchange_failed');
  }
});

// ─── POST: Publish a post to Instagram immediately ────────────────────────────
app.post('/api/instagram/post', async (req, res) => {
  const { ig_id, page_token, caption, image_url } = req.body;

  if (!ig_id || !page_token || !caption) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    // Step A: Create media container
    const containerRes = await axios.post(
      `https://graph.facebook.com/v19.0/${ig_id}/media`,
      null,
      {
        params: {
          caption,
          // If no image provided, use a default Voyloo branded image URL
          image_url: image_url || 'https://voyloo.com/og-image.jpg',
          access_token: page_token
        }
      }
    );

    const containerId = containerRes.data.id;

    // Step B: Publish the container
    const publishRes = await axios.post(
      `https://graph.facebook.com/v19.0/${ig_id}/media_publish`,
      null,
      {
        params: {
          creation_id: containerId,
          access_token: page_token
        }
      }
    );

    res.json({ success: true, post_id: publishRes.data.id });

  } catch (err) {
    console.error('Post error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error?.message || 'Post failed' });
  }
});

// ─── POST: Schedule a post (stores in memory — swap for DB in production) ─────
const scheduledPosts = [];

app.post('/api/instagram/schedule', (req, res) => {
  const { ig_id, page_token, caption, image_url, scheduled_time } = req.body;

  if (!ig_id || !page_token || !caption || !scheduled_time) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const job = {
    id: Date.now(),
    ig_id,
    page_token,
    caption,
    image_url,
    scheduled_time: new Date(scheduled_time),
    status: 'scheduled'
  };

  scheduledPosts.push(job);

  // Set a timeout to post at the right time
  const delay = new Date(scheduled_time) - Date.now();
  if (delay > 0) {
    setTimeout(async () => {
      try {
        const containerRes = await axios.post(
          `https://graph.facebook.com/v19.0/${ig_id}/media`,
          null,
          {
            params: {
              caption,
              image_url: image_url || 'https://voyloo.com/og-image.jpg',
              access_token: page_token
            }
          }
        );
        await axios.post(
          `https://graph.facebook.com/v19.0/${ig_id}/media_publish`,
          null,
          {
            params: {
              creation_id: containerRes.data.id,
              access_token: page_token
            }
          }
        );
        job.status = 'posted';
        console.log(`Scheduled post ${job.id} published successfully`);
      } catch (err) {
        job.status = 'failed';
        console.error(`Scheduled post ${job.id} failed:`, err.response?.data || err.message);
      }
    }, delay);
  }

  res.json({ success: true, job_id: job.id, scheduled_time });
});

// ─── GET: List scheduled posts ─────────────────────────────────────────────────
app.get('/api/instagram/queue', (req, res) => {
  res.json(scheduledPosts.map(p => ({
    id: p.id,
    caption: p.caption,
    scheduled_time: p.scheduled_time,
    status: p.status
  })));
});

// ─── POST: AI content generation (proxies Anthropic API securely) ──────────────
app.post('/api/ai/generate', async (req, res) => {
  const { prompt } = req.body;

  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      },
      {
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        }
      }
    );

    res.json({ text: response.data.content[0].text });
  } catch (err) {
    console.error('AI error:', err.response?.data || err.message);
    res.status(500).json({ error: 'AI generation failed' });
  }
});

app.listen(PORT, () => {
  console.log(`Voyloo Social server running on port ${PORT}`);
});
