/*
 * flex-sdk
 * https://github.com/JamesMGreene/node-flex-sdk
 *
 * Copyright (c) 2013 James M. Greene
 * Licensed under the MIT license.
 */

/*
 * This simply downloads the requested version of the Adobe Flex SDK.
 */

'use strict';

var DEBUG_TRAVIS = false;
var fs = require('fs');
var path = require('path');
var async = require('async');
var Download = require('download');
var rimraf = require('rimraf');
var mkdirp = require('mkdirp');
var glob = require('glob');
var isTextSync = require('istextorbinary').isTextSync;
var pkgMeta = require('./package.json');
var util = require('util');
var os = require('os');


// IMPORTANT:
// This `require` call MUST be done post-download because the export of this
// module is dynamically created based on the executables present after
// downloading and unzipping the relevant Flex SDK.
// If the `require` call is done prior to the download completing, then the
// module's `refresh` function must be invoked afterward to establish the
// correct list of available binaries.
var flexSdk = require('./lib/flex');


var libPath = path.join(__dirname, 'lib', 'flex_sdk');
var downloadUrl = pkgMeta.flexSdk.url;


process.on('uncaughtException', function(err) {
  console.error('FATAL! Uncaught exception: ' + util.inspect(err));
  process.exit(1);
});


function logErrorsToFile(errors, phase) {
  fs.writeFileSync(path.join(__dirname, 'prepublish.log'), JSON.stringify(errors, null, "  "));
  console.error('There were errors during the "' + phase + '"" phase. Check "prepublish.log" for more details!');
}


function cleanDestination(done) {
  if (fs.existsSync(libPath)) {
    rimraf(libPath, function(err) {
      if (err) {
        return done(new Error('Error deleting library path: ' + libPath));
      }
      mkdirp(libPath, done);
    });
  }
  else {
    mkdirp(libPath, done);
  }
}


function downloadIt(done) {
  var notifiedCount = 0;
  var count = 0;
  var notificationChunkSize = 1024 * 1024;

  function onClose(err, files) {
    if (err) {
      done(new Error('Error with download:' + os.EOL + util.inspect(err)));
    } else {
      done();
    }
  }

  function onResponse(response) {
    if (response.statusCode === 302 || response.statusCode === 301) {
      console.log('Following redirect... ' + response.headers.location);
    } else if (response.statusCode >= 400) {
      done(new Error('Error with response:' + os.EOL + 'Status Code: ' + response.statusCode + os.EOL +
        'Headers:' + os.EOL + util.inspect(response.headers) + util.inspect(response.statusCode)));
    } else {
      console.log('Receiving...');
    }
  }

  console.log('Requesting ' + downloadUrl);

  var downloader = new Download({ extract: true })
    .get(downloadUrl, libPath)
    .use(onResponse)
    .run(onClose);
}


function refreshSdk(done) {
  // Start utilizing the API by refreshing its binary cache
  flexSdk.refresh();

  done();
}

function fixLineEndings(done) {
  console.log('Fixing line endings...');

  glob(path.join(libPath, '**', '*'), {}, function (err, files) {
    if (!err) {
      var stats = {
        count: files.length,
        binary: 0,
        skipped: 0,
        fixed: 0,
        directory: 0
      };

      files.forEach(function (file) {
        try {
          if (fs.statSync(file).isDirectory()) {
            stats.directory++;
            stats.skipped++;
          } else {
            var buffer = fs.readFileSync(file);
            if (isTextSync(file, buffer)) {
              var text = fs.readFileSync(file, { encoding: 'utf8' });
              var newText = text.replace(/\r\n|\n|\r/g, '\n');
              if (text !== newText) {
                fs.unlinkSync(file);
                fs.writeFileSync(file, newText);
                stats.fixed++;
              } else {
                stats.skipped++;
              }
            } else {
              stats.binary++;
              stats.skipped++;
            }
          }
        } catch (err) {
          console.log("readFileSync failed: " + util.inspect(err));
          done(err);
        }
      });

      console.log(util.inspect(stats));
      done();
    } else {
      console.log("glob failed: " + util.inspect(err));
      done(err);
    }
  });
}


function fixJavaInvocationsForMac(done) {
  console.log('Fixing Java invocations for OS X ...');
  // Cleanup: RegExp stuff for finding and replacing
  var javaInvocationRegex = /^java .*\$VMARGS/m;
  var javaInvocationMatchingRegex = /^(java .*\$VMARGS)/mg;
  var javaInvocationReplacement = [
    'D32=""',
    'D32_OVERRIDE=""',
    'IS_OSX="`uname | grep -i Darwin`"',
    'IS_JAVA64="`java -version 2>&1 | grep -i 64-Bit`"',
    'JAVA_VERSION="`java -version 2>&1 | awk -F \'[ ".]+\' \'NR==1 {print $$3 "." $$4}\'`"',
    'if [ "$$IS_OSX" != "" -a "$$HOSTTYPE" = "x86_64" -a "$$IS_JAVA64" != "" -a "$$JAVA_VERSION" = "1.6" ]; then',
    '  D32_OVERRIDE="-d32"',
    'fi',
    'VMARGS="$$VMARGS $$D32_OVERRIDE"',
    '',
    '$1'
  ].join('\n');


  // Do the cleanup!
  Object.keys(flexSdk.bin).forEach(function(binKey) {
    var binaryPath = flexSdk.bin[binKey];

    // Ensure that the Bash scripts are updated to work with 64-bit JREs on Mac
    var ext = binaryPath.slice(-4).toLowerCase();
    if (ext !== '.bat' && ext !== '.exe') {
      var contents = fs.readFileSync(binaryPath, { encoding: 'utf8' });
      // Rewrite any Java invocations to ensure they work on Mac
      if (contents.match(javaInvocationRegex)) {
        console.log('Fixing Java invocation for OS X in: ' + binaryPath);
        var cleanedContents = contents.replace(javaInvocationMatchingRegex, javaInvocationReplacement);
        fs.writeFileSync(binaryPath, cleanedContents, { encoding: 'utf8', mode: '755' });
      }
    }
  });

  done();
}


function fixFilePermissions(done) {
  Object.keys(flexSdk.bin).forEach(function(binKey) {
    var binaryPath = flexSdk.bin[binKey];

    // Ensure that the binaries are user-executable (problems with unzip library)
    var stat = fs.statSync(binaryPath);
    // 64 === 0100 (no octal literal in strict mode)
    if (!(stat.mode & 64)) {
      console.log('Fixing file permissions for: ' + binaryPath);
      fs.chmodSync(binaryPath, '755');
    }
  });

  done();
}


//
// Go!
//
async.series([
    cleanDestination,
    downloadIt,
    refreshSdk,
    fixLineEndings,
    fixJavaInvocationsForMac,
    fixFilePermissions
  ],
  function (err) {
    if (err) {
      console.error(err + '\n');
    }
    else {
      // VICTORY!!!
      console.log('SUCCESS! The Flex SDK binaries are available at:\n  ' + flexSdk.binDir + '\n');
    }
    process.exit(err ? 1 : 0);
  }
);