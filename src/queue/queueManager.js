'use strict';

const EventEmitter = require('events');
const logger = require('../utils/logger');

/**
 * In-memory queue backed by EventEmitter.
 * Implements a BullMQ-compatible interface so swapping to Redis/BullMQ later
 * only requires changing this module's implementation.
 *
 * Queue name → { emitter, buffer[] }
 */
const MAX_BUFFER_SIZE = 1000; // retain only the most recent messages for observability
const queues = new Map();

function getOrCreateQueue(queueName) {
  if (!queues.has(queueName)) {
    const emitter = new EventEmitter();
    emitter.setMaxListeners(50);
    queues.set(queueName, { emitter, buffer: [] });
  }
  return queues.get(queueName);
}

/**
 * Enqueue a message to the named queue.
 * @param {string} queueName
 * @param {object} message
 */
function enqueue(queueName, message) {
  const queue = getOrCreateQueue(queueName);
  queue.buffer.push(message);
  // Trim buffer to avoid unbounded memory growth
  if (queue.buffer.length > MAX_BUFFER_SIZE) {
    queue.buffer.splice(0, queue.buffer.length - MAX_BUFFER_SIZE);
  }
  queue.emitter.emit('message', message);
  logger.debug(`[Queue:${queueName}] Enqueued message. Buffer depth: ${queue.buffer.length}`);
}

/**
 * Register a consumer handler for the named queue.
 * The handler is called for each new message enqueued after registration.
 * @param {string} queueName
 * @param {function} handler - async (message) => void
 */
function consume(queueName, handler) {
  const queue = getOrCreateQueue(queueName);
  queue.emitter.on('message', async (message) => {
    try {
      await handler(message);
    } catch (err) {
      logger.error(`[Queue:${queueName}] Handler error: ${err.message}`);
    }
  });
  logger.info(`[Queue:${queueName}] Consumer registered.`);
}

module.exports = { enqueue, consume };
