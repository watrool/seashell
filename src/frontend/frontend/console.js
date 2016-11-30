/**
 * Seashell's frontend console service
 * Copyright (C) 2013-2015 The Seashell Maintainers.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * See also 'ADDITIONAL TERMS' at the end of the included LICENSE file.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

/* jshint supernew: true */
angular.module('frontend-app')
  .service('console-service', ['$rootScope', 'socket', function($scope, socket) {
    var self = this;
    self.PIDs = null;
    // running is true iff we are running with "run", allows input
    self.running = false;
    self.inst = null;
    self.contents = "";
    self.errors = [];
    // Buffers
    self.stdout = "";
    self.stderr = "";
    self._contents = "";
    var ind = "";
    var spl ="";
    var return_codes = {
      "1":"An error occurred",
      "23":"Memory leak",
      "134":"Assertion failed",
      "136":"Erroneous arithmetic operation",
      "139":"Segmentation fault",
      "254":"Program was killed",
      "255":"Timeout"
    };

    // err is a json object (parsed & filtered in backend, only printed here)
    // TODO: better logic (self.write or something?)
    function maybe_log(string){
      var debugmode = false;
      if(debugmode) { console.log(string); }
    }

    function print_asan_error(err) {
      // json object should have:
      // error_type (string)
      // depending on error_type, you can assume each frame-list will have certain key-value pairs, AND
      // at the top level, the json object passed in will also have certain key-value pairs
      // **OR**: have a misc field and just iterate over it and print everything (at the same level as frame_list AND/OR at the very top level with
      // call_stacks: hash (definitely has frame-list; may have other members)
      // frame_list: list of frames (with line numbers, columns, files, etc.
      // frame: column, file, frame#, function, function_offset, line, module, offset
      // raw message
      maybe_log(err);
      if(err.error_type == "unknown" && err.raw_message === "") { return; }
      var to_print = [];
      to_print.push("Memory error occurred! Type of error: " + err.error_type);
      if(err.call_stacks.length === 0) {
        // If no call stack was sent back, fall back to showing the raw ASAN output
        to_print.push("Raw error message:");
        to_print.push(err.raw_message);
      }
      for (var current_stack = 0; current_stack < err.call_stacks.length; current_stack++) {
        maybe_log('current stack: ' + current_stack);
        var framelist = err.call_stacks[current_stack].framelist;
        var framelist_misc = err.call_stacks[current_stack][1];
        // print framelist
        to_print.push('current framelist: ' + current_stack);
        for (var i = 0; i < framelist.length; i++){
          maybe_log('current framelist: ' + i);
          // print each frame
          var framelist_indent = '\t  ';
          if(framelist.length <= 1) { framelist_indent = '\t'; }
          to_print.push(framelist_indent + 'frame ' + framelist[i].frame + ':' +
                        ' function ' + framelist[i].function +
                        ' in file ' + framelist[i].file.replace(/^.*[\\\/]/, '') +
                        ' at line ' + framelist[i].line +
                        ('column' in framelist[i] ? ', column '+framelist[i].column : ''));

        }
        // print misc (Second item)
        for (var key in err.call_stacks[current_stack].misc) {
          maybe_log('printing inner misc: ' + key);
          to_print.push('\t' + key.replace(/_/g, " ") + ': ' + err.call_stacks[current_stack].misc[key]);
        }
        maybe_log('done iterating over inner misc');
      }
      for (var key2 in err.misc) {
        maybe_log('printing outer misc: ' + key2);
        to_print.push(key2.replace(/_/g, " ") + ': ' + err.misc[key2]);
      }
      for (var j = 0; j < to_print.length; j++){
        self._write(to_print[j] + '\n');
      }
      self.flush();
    }

    socket.register_callback("io", function(io) {
      if(io.type == "stdout") {
        ind = io.message.indexOf("\n");
        if (ind > -1) {
          spl = io.message.split("\n");
          self._write(self.stdout);
          while (spl.length>1) { self._write(spl.shift() + "\n"); }
          self.stdout = spl[0];
        }
        else {
          self.stdout += io.message;
        }
      }
      else if(io.type == "stderr") {
        ind = io.message.indexOf("\n");
        if (ind > -1) {
          self._write(self.stderr);
          spl = io.message.split("\n");
          self.stderr = spl[0];
        } else {
          self.stderr += io.message;
        }
      }
      else if (io.type == "done") {
        self._write(self.stdout);
        self._write(self.stderr);
        self.stdout = self.stderr = "";
        if (io.asan) {
          // Print parsed ASAN output
          print_asan_error(JSON.parse(io.asan));
        }
        self.write("Program finished with exit code "+io.status);
        if(io.status !== 0 && return_codes[io.status]) {
          self.write(sprintf(" (%s)", return_codes[io.status]));
        }
        self.write(".\n");
        self.PIDs = null;
        self.running = false;
      }
      self.contents = self._contents;
    });

    function printExpectedFromDiff(res) {
      // res.diff is an array of (string || Array)
      // a string is a line that matches in the diff, so we print 
      // an array a has a[0] false if it came from the expected output
      // a[0] true if it came from the actual output
      // The array contains n lines of text from the lines that differ, n >= 1
      var output = "";
      _.each(res.diff, function(block) {
        if (_.isString(block)) output += "\n" + block;
        else if (block[0] === false) {
          _.each(block.slice(1), function(line) {
            output += "\n" + line;
          });
        }
      });
      self.write(output.substring(1));
    }

    // Prints the test results when in offline mode
    function printTestResultsOffline(res) {

      // true if the runner_ended "normally", ie not by the user
      // pressing STOP button
      var runner_ended = ('type' in res) && res.type === 'done' &&
        ('status' in res) && 'testname' in res;

      if(runner_ended && res.status !== 0) {
        // Runner ended and the exit code is non-zero
        self.write('----------------------------------\n');
        self.write(sprintf("Test \"%s\" caused an error (with return code %d)!\n", res.testname, res.status));
        if('stderr' in res) {
          self.write("Produced output (stderr):\n");
          self.write(res.stderr);
        }
      } else if('stdout' in res && 'expect' in res) {
        // compare actual output with expected output
        if(res.expect !== null && res.stdout == res.expect) {
          // test passed
          self.write('----------------------------------\n');
          self.write(sprintf("Test \"%s\" passed.\n", res.testname));
        } else {
          // test failed or there was no expect file
          self.write('----------------------------------\n');
          if(res.expect === null) {
            self.write('Test ' + res.testname + ' produced output (stdout):\n');
          } else {
            self.write(sprintf("Test \"%s\" failed.\n", res.testname));
            self.write('Produced output (stdout):\n');
          }
          self.write(res.stdout);
          self.write('\n---\n');
          if(res.expect !== null) {
            self.write('Expected output (stdout):\n');
            self.write(res.expect);
            self.write('\n---\n');
          }
          self.write('Produced errors (stderr):\n');
          self.write(res.stderr);
          self.write('\n');
        }
      }

      self.flush();

      if(runner_ended) {

        // A runner for one test case has finished. Remove it from the
        // list of PIDs (similar to what the online mode's code does below)
        self.PIDs = self.PIDs.filter(function(a_pid) {
            // filter/keep the pids whose testname do not match the test
            // that just finished
            return !('testname' in a_pid && a_pid.testname === res.testname);
        });

        self.PIDs = self.PIDs.length === 0 ? null : self.PIDs;
      }
    }

    socket.register_callback("test", function(res) {
      if(socket.isOffline()) {
        printTestResultsOffline(res);
        return;
      }

      self.PIDs = _.without(self.PIDs, res.pid);
      self.PIDs = self.PIDs.length === 0 ? null : self.PIDs;
      var parsedASAN = res.asan_output ? JSON.parse(res.asan_output) : false;

      if(res.result==="passed") {
        self.write('----------------------------------\n');
        self.write(sprintf("Test \"%s\" passed.\n", res.test_name));
      }
      else if(res.result==="failed") {
        self.write('----------------------------------\n');
        self.write(sprintf("Test \"%s\" failed.\n", res.test_name));
        self.write('Produced output (stdout):\n');
        self.write(res.stdout);
        self.write('---\n');
        self.write('Expected output (stdout):\n');
        printExpectedFromDiff(res);
        self.write('---\n');
        self.write('Produced errors (stderr):\n');
        self.write(res.stderr);
        if(parsedASAN.raw_message !== "") {
            self.write("AddressSanitizer Output:\n");
            print_asan_error(parsedASAN);
        }
      } else if(res.result==="error") {
        self.write('----------------------------------\n');
        self.write(sprintf("Test \"%s\" caused an error (with return code %d)!\n", res.test_name, res.exit_code));
        self.write('Produced output (stderr):\n');
        self.write(res.stderr);
        if(parsedASAN.raw_message !== "") {
            // Parse the ASAN json string that the backend gives us.
            self.write("AddressSanitizer Output:\n");
            print_asan_error(parsedASAN);
        }
      } else if(res.result==="no-expect") {
        self.write('----------------------------------\n');
        self.write(sprintf("Test \"%s\" produced output (stdout):\n", res.test_name));
        self.write(res.stdout);
        self.write('Produced output (stderr):\n');
        self.write(res.stderr);
        if(parsedASAN.raw_message !== "") {
            // Parse the ASAN json string that the backend gives us.
            self.write("AddressSanitizer Output:\n");
            print_asan_error(parsedASAN);
        }
      } else if(res.result==="timeout") {
        self.write('----------------------------------\n');
        self.write(sprintf("Test \"%s\" timed out.\n", res.test_name));
      }
      else if(res.result==="killed") {
        self.write('----------------------------------\n');
        self.write(sprintf("Test \"%s\" was killed.\n", res.test_name));
      }
      self.flush();
    });

    self.setRunning = function(project, PIDs, testing) {
      self.running = !testing;
      self.PIDs = PIDs;
      _.each(self.PIDs, function (pid) {
        socket.startIO(project.name, pid);
      });
    };
    self.clear = function() {
      self.contents = self._contents = "";
      self.stdin = self.stdout = "";
    };
    self._write = function(msg) {
      self._contents += msg;
    };
    self.write = function(msg) {
      self.flush();
      self._write(msg);
      self.flush();
    };
    self.flush = function () {
      self.contents = self._contents + self.stdout + self.stderr;
    };
    self.flushForInput = function () {
      self._contents += self.stdout + self.stderr;
      self.stdout = self.stderr = "";
    };
  }]);
