#!/usr/bin/env node

var fuse = require('fuse-bindings')
var fs = require('fs')
var join = require('path').join
var hyperdrive = require('hyperdrive')
var hyperdiscovery = require('hyperdiscovery')
var pager = require('memory-pager')
var minimist = require('minimist')
var mkdirp = require('mkdirp')
var proc = require('child_process')

var argv = minimist(process.argv.slice(2), {
  alias: {
    key: 'k',
    image: 'i',
    boot: 'b',
    dir: 'd'
  },
  default: {
    dir: '.'
  }
})

if (argv.dir !== '.') mkdirp.sync(argv.dir)

if (!argv.image) {
  console.error('--image or -i is required')
  process.exit(1)
}

if (process.getuid() !== 0) {
  console.error('Need to be root')
  process.exit(2)
}

var indexLoaded = false
var nspawn = null
var storage = (!argv.ram && !argv.index) ? join(argv.dir, './archive') : require('random-access-memory')
var archive = hyperdrive(storage, argv.key && argv.key.replace('dat://', ''), {
  createIfMissing: false,
  sparse: true
})

if (argv.image[0] !== '/') argv.image = '/' + argv.image

var track = argv.index ? fs.createWriteStream(argv.index) : null
var mirrored = join(argv.dir, './tmp')
var mnt = join(argv.dir, './mnt')
var writtenBlocks = pager(4096)
var totalDownloaded = 0
var blocks = 0
var lastBlocks = []

var range = null
var bufferSize = parseInt(argv.buffer || 0, 10)

archive.once('content', function () {
  archive.content.allowPush = true
  archive.content.on('download', function (index, data) {
    if (track) track.write('' + index + '\n')
    if (range) archive.content.undownload(range)
    if (bufferSize) {
      range = archive.content.download({
        start: index,
        end: Math.min(archive.content.length, index + bufferSize),
        linear: true
      })
    }

    totalDownloaded += data.length
    blocks++
    lastBlocks.push(index)
    if (lastBlocks.length > 5) lastBlocks.shift()
  })
})

if (argv.stats) onstats()

archive.on('ready', function () {
  hyperdiscovery(archive, {live: true})
})

process.on('SIGINT', sigint)

mkdirp.sync(mirrored)
try {
  mkdirp.sync(mnt)
} catch (err) {
  // do nothing
}

unmount(mnt, mount)

function mount () {
  fuse.mount(mnt, {
    readdir: function (path, cb) {
      if (isMirrored(path)) fs.readdir(mirrored + path, done)
      else archive.readdir(path, done)

      function done (err, folders) {
        if (err) return cb(toErrno(err))
        cb(0, folders)
      }
    },
    getattr: function (path, cb) {
      if (isMirrored(path)) fs.lstat(mirrored + path, done)
      else archive.lstat(path, done)

      function done (err, st) {
        if (err) return cb(toErrno(err))
        cb(null, st)
      }
    },
    unlink: function (path, cb) {
      if (isMirrored(path)) fs.unlink(mirrored + path, done)
      else archive.unlink(path, done)

      function done (err) {
        if (err) return cb(toErrno(err))
        cb(0)
      }
    },
    create: function (path, mode, cb) {
      fs.open(mirrored + path, 'w', mode, done)

      function done (err, fd) {
        if (err) return cb(toErrno(err))
        cb(0, fd)
      }
    },
    open: function (path, flags, cb) {
      if (isMirrored(path)) fs.open(mirrored + path, flags, done)
      else archive.open(path, flags, {download: false}, done)

      function done (err, fd) {
        if (err) return cb(toErrno(err))
        cb(0, fd)
      }
    },
    release: function (path, fd, cb) {
      if (isMirrored(path)) fs.close(fd, done)
      else archive.close(fd, done)

      function done (err) {
        cb(err ? err.errno : -1, 0)
      }
    },
    write: function (path, fd, buf, len, pos, cb) {
      var offset = pos & 4095
      var page = (pos - offset) / 4096
      var blk = writtenBlocks.get(page)
      buf.copy(blk.buffer, offset)
      cb(len)
    },
    read: function (path, fd, buf, len, pos, cb) {
      var totalRead = 0

      run(fd, buf, 0, len, pos, done)

      function done (err, read) {
        if (err) return cb(toErrno(err))
        totalRead += read
        if (!read || totalRead === len) return cb(totalRead)
        run(fd, buf, totalRead, len - totalRead, pos + totalRead, done)
      }

      function run (fd, buf, offset, len, pos, done) {
        if (path === argv.image) {
          var overflow = pos & 4095
          var page = (pos - overflow) / 4096
          var blk = writtenBlocks.get(page, true)

          if (blk) {
            var b = blk.buffer
            if (b.length > len) b = b.slice(0, len)
            if (overflow) b = b.slice(overflow)
            b.copy(buf, offset, 0, b.length)
            return process.nextTick(done, null, b.length)
          }
        }

        if (isMirrored(path)) fs.read(fd, buf, offset, len, pos, done)
        else archive.read(fd, buf, offset, len, pos, done)
      }
    }
  }, function (err) {
    if (err) throw err
    check()
    archive.metadata.on('remote-update', check)
    archive.metadata.on('append', check)
  })
}

function isMirrored (name) {
  return /\/\./.test(name) || !/\.img$/.test(name)
}

function toErrno (err) {
  if (err.errno) return err.errno
  if (err.notFound) return fuse.ENOENT
  return -1
}

function sigint () {
  if (nspawn) return process.kill(nspawn.pid, 'SIGKILL')
  unmount(mnt, function () {
    process.exit(1)
  })
}

function onstats () {
  console.log('(Stats server listening on 10000)')
  require('http').createServer(function (req, res) {
    var interval = setInterval(stats, 1000)
    stats()
    res.on('close', function () {
      clearInterval(interval)
    })

    function stats () {
      res.write('Bytes downloaded  : ' + totalDownloaded + '\n')
      res.write('Blocks downloaded : ' + blocks + '\n')
      res.write('Last blocks       : ' + lastBlocks.join(' ') + '\n')
    }
  }).listen(10000)
}

function checkIndex () {
  archive.readFile(argv.image + '.index', function (_, buf) {
    if (!buf) return
    indexLoaded = true

    var btm = 0
    var indexes = buf.toString('utf-8').trim().split('\n').map(function (n) {
      return parseInt(n, 10)
    })

    archive.once('content', update)
    update()

    function update () {
      if (!archive.content) return

      while (btm < indexes.length) {
        if (archive.content.has(indexes[btm])) {
          btm++
        } else {
          break
        }
      }

      var missing = 5

      for (var i = btm; i < indexes.length && missing; i++) {
        var idx = indexes[i]
        if (archive.content.has(idx)) continue
        missing--
        if (downloading(idx)) continue
        archive.content.download(idx, update)
      }
    }

    function downloading (index) {
      for (var i = 0; i < archive.content._selections.length; i++) {
        var s = archive.content._selections[i]
        if (s.start <= index && index < s.end) return true
      }
      return false
    }
  })
}

function check () {
  if (!indexLoaded) checkIndex()
  if (nspawn) return
  archive.stat(argv.image, function (err, st) {
    if (err || nspawn) return

    var args = ['-i', join(mnt, argv.image)]
    if (argv.boot) args.push('-b')
    else if (argv.quiet !== false) args.push('-q')
    if (argv.bind) args.push('--bind', argv.bind)

    Object.keys(argv).forEach(function (k) {
      if (k.slice(0, 3) === 'sn-') {
        args.push('--' + k.slice(3))
        if (argv[k] !== true) args.push(argv[k])
      }
    })

    argv._.forEach(function (a) {
      args.push(a)
    })

    process.removeListener('SIGINT', sigint)
    nspawn = proc.spawn('systemd-nspawn', args, {
      stdio: 'inherit'
    })
    nspawn.on('exit', function (code) {
      unmount(mnt, function () {
        process.exit(code)
      })
    })
  })

}

function unmount (mnt, cb) {
  proc.spawn('umount', ['-f', mnt]).on('exit', cb)
}
