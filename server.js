require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// CORS configuration
app.use(cors());
app.use(express.json());

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Validate API keys
if (!process.env.BINANCE_API_KEY || !process.env.BINANCE_API_SECRET) {
  console.error('Warning: BINANCE_API_KEY or BINANCE_API_SECRET missing in .env file');
  console.error('API endpoints will not work without valid credentials');
}

// Binance Testnet API configuration
const API_KEY = process.env.BINANCE_API_KEY;
const API_SECRET = process.env.BINANCE_API_SECRET;
const BASE_URL = 'https://testnet.binancefuture.com';

// Helper function to create signature for Binance API
const createSignature = (queryString) => {
  return crypto
    .createHmac('sha256', API_SECRET)
    .update(queryString)
    .digest('hex');
};

// Helper function to make authenticated requests to Binance API
const makeRequest = async (endpoint, method = 'GET', params = {}) => {
  try {
    // Add timestamp to params
    const timestamp = Date.now();
    const queryParams = {
      ...params,
      timestamp,
      recvWindow: 60000, // Increase receive window to account for any time drift
    };

    // Convert params to query string
    const queryString = Object.keys(queryParams)
      .map(key => `${key}=${queryParams[key]}`)
      .join('&');

    // Create signature
    const signature = createSignature(queryString);
    
    // Prepare headers
    const headers = {
      'X-MBX-APIKEY': API_KEY,
    };

    // Make request
    const url = `${BASE_URL}${endpoint}?${queryString}&signature=${signature}`;
    console.log(`Making request to: ${url}`);
    
    const response = await axios({
      method,
      url,
      headers,
    });

    return response.data;
  } catch (error) {
    console.error('API request error:', error.response ? error.response.data : error.message);
    throw error;
  }
};

// Helper function to handle errors
const handleError = (res, error, message) => {
  const errorDetails = error.response ? error.response.data : error.message;
  console.error(`${message}:`, errorDetails);
  res.status(500).json({ error: message, details: errorDetails });
};

// Endpoint to get current BTC/USDT price
app.get('/api/current-price', async (req, res) => {
  try {
    const response = await axios.get(`${BASE_URL}/fapi/v1/ticker/price`, {
      params: { symbol: 'BTCUSDT' },
    });
    console.log('Price response:', response.data); // Debug log
    res.json({
      price: parseFloat(response.data.price).toFixed(2),
    });
  } catch (error) {
    handleError(res, error, 'Error fetching current price');
  }
});

// Endpoint to get account balance (USDT)
app.get('/api/balance', async (req, res) => {
  try {
    const account = await makeRequest('/fapi/v2/account');
    console.log('Account response:', account); // Debug log
    
    const usdtBalance = account.assets.find(asset => asset.asset === 'USDT');
    if (!usdtBalance) throw new Error('USDT asset not found');
    
    res.json({
      availableBalance: parseFloat(usdtBalance.availableBalance).toFixed(2),
      walletBalance: parseFloat(usdtBalance.walletBalance).toFixed(2),
    });
  } catch (error) {
    handleError(res, error, 'Error fetching balance');
  }
});

// Endpoint to get unrealized PNL for open positions
app.get('/api/unrealized-pnl', async (req, res) => {
  try {
    const positions = await makeRequest('/fapi/v2/positionRisk');
    console.log('Positions response:', positions); // Debug log
    
    const openPositions = positions.filter(pos => parseFloat(pos.positionAmt) !== 0);
    const totalUnrealizedPNL = openPositions.reduce((sum, pos) => sum + parseFloat(pos.unRealizedProfit), 0);
    
    res.json({
      totalUnrealizedPNL: totalUnrealizedPNL.toFixed(2),
      positions: openPositions.map(pos => ({
        symbol: pos.symbol,
        unrealizedProfit: parseFloat(pos.unRealizedProfit).toFixed(2),
        positionAmt: parseFloat(pos.positionAmt),
        leverage: pos.leverage,
      })),
    });
  } catch (error) {
    handleError(res, error, 'Error fetching unrealized PNL');
  }
});

// Endpoint to get open orders for BTCUSDT
app.get('/api/open-orders', async (req, res) => {
  try {
    const openOrders = await makeRequest('/fapi/v1/openOrders', 'GET', {
      symbol: 'BTCUSDT',
    });
    console.log('Open orders response:', openOrders); // Debug log

    const formattedOrders = openOrders.map(order => {
      let orderDescription = order.type;
      const side = order.side;
      const price = order.stopPrice || order.price || 'N/A';

      // Determine if it's a stop loss or take profit, as in checkorders.py
      if (order.type === 'STOP_MARKET' && side !== 'BUY') {
        orderDescription = 'Stop Loss';
      } else if (order.type === 'TAKE_PROFIT_MARKET' && side !== 'BUY') {
        orderDescription = 'Take Profit';
      } else if (order.type === 'STOP_MARKET' && side === 'BUY') {
        orderDescription = 'Stop Loss';
      } else if (order.type === 'TAKE_PROFIT_MARKET' && side === 'BUY') {
        orderDescription = 'Take Profit';
      }

      return {
        orderId: order.orderId,
        type: orderDescription,
        side,
        price: parseFloat(price).toFixed(2) || price,
      };
    });

    res.json({
      count: openOrders.length,
      orders: formattedOrders,
    });
  } catch (error) {
    handleError(res, error, 'Error fetching open orders');
  }
});

// Endpoint to get the most recent 50 transactions (trades) with non-zero realized PNL
app.get('/api/transactions', async (req, res) => {
  try {
    // Initialize variables for pagination
    let allTrades = [];
    let nonZeroPnlTrades = [];
    let fromId = null;
    const maxPages = 10; // Safety limit to prevent infinite loops
    let currentPage = 0;
    
    // Continue fetching until we have at least 50 non-zero PNL trades or reach max pages
    while (nonZeroPnlTrades.length < 50 && currentPage < maxPages) {
      // Prepare query parameters
      const queryParams = {
        limit: 1000 // Maximum allowed by Binance API
      };
      
      // Add fromId for pagination if we have one
      if (fromId) {
        queryParams.fromId = fromId;
      }
      
      console.log(`Fetching page ${currentPage + 1} with params:`, queryParams);
      
      // Fetch trades
      const pageTrades = await makeRequest('/fapi/v1/userTrades', 'GET', queryParams);
      
      console.log(`Received ${pageTrades.length} trades on page ${currentPage + 1}`);
      
      // If no trades returned, break the loop
      if (pageTrades.length === 0) {
        break;
      }
      
      // Add to all trades
      allTrades = allTrades.concat(pageTrades);
      
      // Update fromId for next page (use the oldest trade's ID)
      if (pageTrades.length > 0) {
        // Sort by ID to find the oldest one
        const oldestTrade = [...pageTrades].sort((a, b) => a.id - b.id)[0];
        fromId = oldestTrade.id;
      }
      
      // Filter for non-zero PNL trades
      const newNonZeroPnlTrades = pageTrades.filter(trade => 
        parseFloat(trade.realizedPnl) !== 0
      );
      
      // Add to our collection
      nonZeroPnlTrades = nonZeroPnlTrades.concat(newNonZeroPnlTrades);
      
      console.log(`Found ${newNonZeroPnlTrades.length} non-zero PNL trades on this page. Total: ${nonZeroPnlTrades.length}`);
      
      // Increment page counter
      currentPage++;
    }
    
    console.log(`Total trades fetched: ${allTrades.length}`);
    console.log(`Total non-zero PNL trades found: ${nonZeroPnlTrades.length}`);
    
    // Sort by time, newest first
    nonZeroPnlTrades.sort((a, b) => parseInt(b.time) - parseInt(a.time));
    
    // Take only the most recent 50
    const limitedTrades = nonZeroPnlTrades.slice(0, 100);
    
    // Log the time range of the trades we're returning
    if (limitedTrades.length > 0) {
      const newestTime = new Date(parseInt(limitedTrades[0].time)).toLocaleString();
      const oldestTime = new Date(parseInt(limitedTrades[limitedTrades.length - 1].time)).toLocaleString();
      console.log(`Returning trades from ${newestTime} to ${oldestTime}`);
    }
    
    res.json(
      limitedTrades.map(trade => ({
        symbol: trade.symbol,
        side: trade.side,
        price: parseFloat(trade.price).toFixed(2),
        qty: parseFloat(trade.qty).toFixed(4),
        quoteQty: parseFloat(trade.quoteQty || (trade.price * trade.qty)).toFixed(4),
        commission: parseFloat(trade.commission || 0).toFixed(8),
        time: new Date(parseInt(trade.time)).toLocaleString(),
        realizedPnl: parseFloat(trade.realizedPnl).toFixed(2),
      }))
    );
  } catch (error) {
    handleError(res, error, 'Error fetching transactions');
  }
});

// Simple health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve index.html for all other routes (SPA support)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
  console.log(`Using Binance Testnet API at ${BASE_URL}`);
});