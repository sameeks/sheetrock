/*!
 * jquery-sheetrock v0.3.0
 * Quickly connect to, query, and lazy-load data from Google Spreadsheets.
 * http://chriszarate.github.io/sheetrock/
 * License: MIT
 */

(function (root, factory) {

  'use strict';

  /* global define, module, require */

  if (typeof define === 'function' && define.amd) {
    define(['jquery'], factory);
  } else if (typeof module === 'object' && module.exports) {
    factory(require('jquery'));
  } else {
    factory(root.jQuery || root.$);
  }

}(this, function ($) {

  'use strict';

  /* Main */

  var sheetrock = function (options, bootstrappedData) {

    // Store reference to `this`.
    options.target = this;

    // Load and validate options.
    options = validateOptions(options);

    // Proceed if options are valid.
    if (options) {

      // Check for bootstrapped data.
      if (isDefined(bootstrappedData) && bootstrappedData !== null) {
        processResponse.call(options, bootstrappedData);
      } else {
        fetchRequest(options);
      }

    }

    // Return `this` to allow jQuery object chaining.
    return this;

  };


  /* Setup */

  // Google API endpoints and key formats
  var spreadsheetTypes = {
    '2014': {
      'endpoint': 'https://docs.google.com/spreadsheets/d/%key%/gviz/tq',
      'keyFormat': new RegExp('spreadsheets/d/([^/#]+)', 'i')
    },
    '2010': {
      'endpoint': 'https://spreadsheets.google.com/tq?key=%key%',
      'keyFormat': new RegExp('key=([^&#]+)', 'i')
    }
  };

  // Placeholder for request status cache
  var requestStatusCache = {
    loaded: {},
    failed: {},
    offset: {}
  };

  // JSONP callback function index
  var jsonpCallbackIndex = 0;


  /* Data fetchers */

  // Fetch the requested data using the user's options.
  var fetchRequest = function (options) {

    // Specify a custom callback function since Google doesn't use the
    // default implementation favored by jQuery.
    var jsonpCallbackName = 'sheetrock_callback_' + jsonpCallbackIndex;
    jsonpCallbackIndex = jsonpCallbackIndex + 1;

    // AJAX request options
    var request = {

      // Convert user options into AJAX request parameters.
      data: {
        gid: options.gid,
        tq: options.query,
        tqx: 'responseHandler:' + jsonpCallbackName
      },

      // Use user options object as context (`this`) for data handler.
      context: options,

      url: options.apiEndpoint,
      dataType: 'jsonp',
      cache: true,

      // Use custom callback function (see above).
      jsonp: false,
      jsonpCallback: jsonpCallbackName

    };

    // If debugging is enabled, log request details to the console.
    log(request, options.debug);

    // Send the request.
    $.ajax(request)

      // Validate the response data.
      .done(processResponse)

      // Handle error.
      .fail(handleError);

  };


  /* Data validators */

  // Enumerate any messages embedded in the API response.
  var enumerateMessages = function (data, state) {

    // Look for the specified property at the root of the response object.
    if (has(data, state)) {

      // Look for the kinds of messages we know about.
      $.each(data[state], function (i, status) {
        if (has(status, 'detailed_message')) {
          /* jshint camelcase: false */
          // jscs:disable requireCamelCaseOrUpperCaseIdentifiers
          log(status.detailed_message);
          // jscs:enable
        } else if (has(status, 'message')) {
          log(status.message);
        }
      });

    }

  };

  // Validate API response.
  var processResponse = function (data) {

    // Enumerate any returned warning messages.
    enumerateMessages(data, 'warnings');

    // Enumerate any returned error messages.
    enumerateMessages(data, 'errors');

    // Log the API response to the console, if requested.
    log(data, this.debug);

    // Make sure the response is populated with actual data.
    if (has(data, 'status', 'table') && has(data.table, 'cols', 'rows')) {

      // Extend the options hash with useful information about the response.
      var parsedOptions = extendOptions.call(this, data);

      // Pass the API response to the data handler.
      this.dataHandler.call(parsedOptions, data);

      // Call the user's callback function.
      this.callback(this, data);

    } else {

      // The response seems empty; call the error handler.
      handleError.call(this, data);

    }

  };

  // Extend the options hash with useful information about the response.
  var extendOptions = function (data) {

    // Store reference to the options hash.
    var options = this;

    // Initialize a hash for parsed options.
    options.parsed = {};

    // The Google API generates an unrecoverable error when the 'offset' is
    // larger than the number of available rows, which is problematic for
    // chunked requests. As a workaround, we request one more row than we need
    // and stop when we see less rows than we requested.

    // Calculate the last returned row.
    options.parsed.last =
      (options.chunkSize) ? Math.min(data.table.rows.length, options.chunkSize) : data.table.rows.length;

    // Remember whether this request has been fully loaded.
    requestStatusCache.loaded[options.requestID] =
      !options.chunkSize || options.parsed.last < options.chunkSize;

    // Determine if Google has extracted column labels from a header row.
    options.parsed.header =
      ($.map(data.table.cols, getColumnLabel).length) ? 1 : 0;

    // If no column labels are provided or if there are too many or too few
    // compared to the returned data, use the returned column labels.
    options.parsed.labels =
      (options.labels && options.labels.length === data.table.cols.length) ? options.labels : $.map(data.table.cols, getColumnLabelOrLetter);

    // Return extended options.
    return options;

  };


  /* Data parsers */

  // Parse data, row by row.
  var parseData = function (data) {

    // Store reference to the options hash and target.
    var options = this;
    var target = options.target;
    var isTable = (target.prop('tagName') === 'TABLE');

    // Add row group tags (<thead>, <tbody>) if the target is a table.
    $.extend(options, {
      thead: (isTable) ? $('<thead/>').appendTo(target) : target,
      tbody: (isTable) ? $('<tbody/>').appendTo(target) : target
    });

    // Output a header row, if needed.
    if (!options.offset && !options.headersOff) {
      if (options.parsed.header || !options.headers) {
        options.thead.append(options.rowHandler({
          num: 0,
          cells: arrayToObject(options.parsed.labels)
        }));
      }
    }

    // Each table cell ('c') can contain two properties: 'p' contains
    // formatting and 'v' contains the actual cell value.

    // Loop through each table row.
    $.each(data.table.rows, function (i, obj) {

      // Proceed if the row has cells and the row index is within the targeted
      // range. (This avoids displaying too many rows when chunking data.)
      if (has(obj, 'c') && i < options.parsed.last) {

        // Get the "real" row index (not counting header rows).
        var counter = stringToNaturalNumber(options.offset + i + 1 + options.parsed.header - options.headers);

        // Initialize a row object, which will be passed to the row handler.
        var rowObject = {
          num: counter,
          cells: {}
        };

        // Suppress header row, if requested.
        if (counter || !options.headersOff) {

          // Loop through each cell in the row.
          $.each(obj.c, function (x, cell) {

            // Extract cell value.
            var value = (cell && has(cell, 'v') && cell.v) ? cell.v : '';

            // Avoid array cell values.
            if (value instanceof Array) {
              value = (has(cell, 'f')) ? cell.f : value.join('');
            }

            // Add the trimmed cell value to the row object, using the desired
            // column label as the key.
            rowObject.cells[options.parsed.labels[x]] = trim(value);

          });

          // Pass the row object to the row handler and append the output to
          // the target element.

          if (rowObject.num) {
            // Append to table body.
            options.tbody.append(options.rowHandler(rowObject));
          } else {
            // Append to table header.
            options.thead.append(options.rowHandler(rowObject));
          }

        }

      }

    });

  };


  /* User input validator */

  // Validate user-passed options.
  var validateOptions = function (options) {

    // Extend default options.
    options = $.extend({}, $.fn.sheetrock.defaults, options);

    // Support some legacy option names.
    options.query = options.sql || options.query;
    options.callback = options.userCallback || options.callback;

    // Get spreadsheet type.
    options.type = getSpreadsheetType(options.url);

    // Get spreadsheet key and gid.
    options.key = extractKey(options.url, options.type);
    options.gid = extractGID(options.url);

    // Set API endpoint.
    options.apiEndpoint = options.type.endpoint.replace('%key%', options.key);

    // Set request ID (key_gid_query).
    if (options.key && options.gid) {
      options.requestID = options.key + '_' + options.gid + '_' + options.query;
    }

    // Validate chunk size.
    options.chunkSize = (options.target.length) ? stringToNaturalNumber(options.chunkSize) : 0;

    // Validate number of header rows.
    options.headers = stringToNaturalNumber(options.headers);

    // If requested, reset request status.
    if (options.resetStatus && options.requestID) {
      requestStatusCache.loaded[options.requestID] = false;
      requestStatusCache.failed[options.requestID] = false;
      requestStatusCache.offset[options.requestID] = 0;
      log('Resetting request status.');
    }

    // Retrieve current row offset.
    options.offset = requestStatusCache.offset[options.requestID] || 0;

    // If requested, make a request for chunked data.
    if (options.chunkSize && options.target && options.requestID) {

      // Append a limit and row offest to the query to target the next chunk.
      options.query += ' limit ' + (options.chunkSize + 1);
      options.query += ' offset ' + options.offset;

      // Remember the new row offset.
      requestStatusCache.offset[options.requestID] = options.offset + options.chunkSize;

    }

    // Require `this` or a data handler. Otherwise, the data has nowhere to go.
    if (!options.target.length && options.dataHandler === parseData) {
      return handleError.call(options, null, 'No element targeted or data handler provided.');
    }

    // Require a spreadsheet URL.
    if (!options.url) {
      return handleError.call(options, null, 'No spreadsheet URL provided.');
    }

    // Require a spreadsheet key.
    if (!options.key) {
      return handleError.call(options, null, 'Could not find a key in the provided URL.');
    }

    // Require a spreadsheet gid.
    if (!options.gid) {
      return handleError.call(options, null, 'Could not find a gid in the provided URL.');
    }

    // Abandon requests that have previously generated an error.
    if (requestStatusCache.failed[options.requestID]) {
      return handleError.call(options, null, 'A previous request for this resource failed.');
    }

    // Abandon requests that have already been loaded.
    if (requestStatusCache.loaded[options.requestID]) {
      return log('No more rows to load!');
    }

    // Log the validated options to the console, if requested.
    log(options, options.debug);

    return options;

  };

  // General error handler.
  var handleError = function (data, msg) {

    // Set error message.
    msg = msg || 'Request failed.';

    // Remember that this request failed.
    if (this && this.requestID) {
      requestStatusCache.failed[this.requestID] = true;
    }

    // Log the error to the console.
    log(msg);

    // Call the user's error handler.
    this.errorHandler.call(this, data, msg);

    return false;

  };


  /* Miscellaneous functions */

  // Trim a string of leading and trailing spaces.
  var trim = function (str) {
    return str.toString().replace(/^ +/, '').replace(/ +$/, '');
  };

  // Parse a string as a natural number (>=0).
  var stringToNaturalNumber = function (str) {
    return Math.max(0, parseInt(str, 10) || 0);
  };

  // Return true if an object has all of the passed arguments as properties.
  var has = function (obj) {
    var i;
    var length = arguments.length;
    for (i = 1; i < length; i = i + 1) {
      if (!isDefined(obj[arguments[i]])) {
        return false;
      }
    }
    return true;
  };

  // Return true if all of the passed arguments are defined.
  var isDefined = function () {
    var i;
    var length = arguments.length;
    for (i = 0; i < length; i = i + 1) {
      if (typeof arguments[i] === 'undefined') {
        return false;
      }
    }
    return true;
  };

  // Log something to the browser console, if it exists. The argument "show"
  // is a Boolean (default = true) that determines whether to proceed.
  var log = function (msg, show) {
    /* jshint devel: true */
    show = (isDefined(show, console)) ? show : true;
    if (show && console.log) {
      console.log(msg);
    }
    return false;
  };

  // Get spreadsheet "type" from Google Spreadsheet URL (default is "2014").
  var getSpreadsheetType = function (url) {

    var returnValue;

    $.each(spreadsheetTypes, function (key, spreadsheetType) {
      if (spreadsheetType.keyFormat.test(url)) {
        returnValue = spreadsheetType;
        return false;
      }
    });

    return returnValue || spreadsheetTypes['2014'];

  };

  // Extract the "key" from a Google spreadsheet URL.
  var extractKey = function (url, spreadsheetType) {
    return (spreadsheetType.keyFormat.test(url)) ? url.match(spreadsheetType.keyFormat)[1] : false;
  };

  // Extract the "gid" from a Google spreadsheet URL.
  var extractGID = function (url) {
    var gidRegExp = new RegExp('gid=([^/&#]+)', 'i');
    return (gidRegExp.test(url)) ? url.match(gidRegExp)[1] : false;
  };

  // Extract the label, if present, from a column object, sans white space.
  var getColumnLabel = function (col) {
    return (has(col, 'label')) ? col.label.replace(/\s/g, '') : null;
  };

  // Map function: Return the label or letter of a column object.
  var getColumnLabelOrLetter = function (col) {
    return getColumnLabel(col) || col.id;
  };

  // Convert an array to a object.
  var arrayToObject = function (arr) {
    var obj = {};
    $.each(arr, function (i, str) {
      obj[str] = str;
    });
    return obj;
  };

  // Default row handler: Output a row object as an HTML table row.
  var toHTML = function (row) {

    var cell;
    var html = '';

    // Use "td" for table body row, "th" for table header rows.
    var tag = (row.num) ? 'td' : 'th';

    // Loop through each cell in the row.
    for (cell in row.cells) {
      if (row.cells.hasOwnProperty(cell)) {
        // Wrap the cell value in the cell tag.
        html += wrapTag(row.cells[cell], tag);
      }
    }

    // Wrap the cells in a table row tag.
    return wrapTag(html, 'tr');

  };

  // Wrap a string in tag. The style argument, if present, is populated into
  // an inline CSS style attribute. (Gross!)
  var wrapTag = function (str, tag) {
    return '<' + tag + '>' + str + '</' + tag + '>';
  };


  /* API */

  // Documentation is available at:
  // https://github.com/chriszarate/sheetrock/

  sheetrock.version = '0.3.0';

  // Changes in 1.0.0:
  // -----------------
  // - *renamed* .options => .defaults
  // - *removed* .promise -- requests are no longer chained
  // - *removed* .working -- use callback function

  // Todo:
  // -----
  // - rename chunkSize
  // - always append data when Sheetrock is chained to jQuery object
  // - remove dataHandler option (merged with userCallback)
  // - remove/merge labels option?
  // - remove/merge errorHandler option?
  // - remove/merge header options?

  sheetrock.defaults = {

    // Changes in 1.0.0:
    // -----------------
    // - *renamed* sql => query
    // - *removed* server -- pass data as parameter instead
    // - *removed* columns -- always use column letters in query
    // - *removed* cellHandler -- use rowHandler for text formatting
    // - *removed* loading -- use callback function
    // - *removed* rowGroups -- <thead>, <tbody> added when target is <table>
    // - *removed* formatting -- almost useless, impossible to support

    url:          '',          // String  -- Google spreadsheet URL
    query:        '',          // String  -- Google Visualization API query
    chunkSize:    0,           // Integer -- Number of rows to fetch (0 = all)
    labels:       [],          // Array   -- Override *returned* column labels
    rowHandler:   toHTML,      // Function
    dataHandler:  parseData,   // Function
    errorHandler: $.noop,      // Function
    callback:     $.noop,      // Function
    headers:      0,           // Integer -- Number of header rows
    headersOff:   false,       // Boolean -- Suppress header row output
    resetStatus:  false,       // Boolean -- Reset request status
    debug:        false        // Boolean -- Output raw data to the console

  };

  $.fn.sheetrock = sheetrock;
  return sheetrock;

}));
